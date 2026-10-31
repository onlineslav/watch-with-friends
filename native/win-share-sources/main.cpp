// win-share-sources
//
// Lists what the share picker offers (every screen and every shareable window, each with a
// thumbnail) once every REFRESH_MS, for as long as it runs. Electron's desktopCapturer.getSources
// does the same on the app's main process, and measured it froze that process for 450-700ms per
// call (enumerating screens alone ~600ms), so a picker refreshing every 2s made the whole window
// hang and stutter. Here it costs the app nothing: this process does the work, and main only
// reads its lines.
//
// One JSON line per refresh on stdout:
//   {"sources":[{"id":"screen:0:0","name":"Entire screen","thumbnail":"data:image/jpeg;base64,..."},
//               {"id":"window:<hwnd>:0","name":"...","thumbnail":...}, ...]}
// Ids are the ones Chromium itself uses, so the display-media handler grants them as they are:
// `screen:<n>:0` with n the EnumDisplayDevices index of an active display (Chromium's own screen
// list numbers screens that way), `window:<hwnd>:0`. The windows are the ones desktopCapturer
// lists: visible top-level windows with a title, not owned (unless they ask for a taskbar
// button), not cloaked; minimized ones too, without a thumbnail. Left out: this app's own windows
// (its parent process), and tool windows and click-through overlays (a GPU overlay, say), which
// desktopCapturer lists but nobody means to share. Titles come from InternalGetWindowText, which never waits on the
// window's thread, and a hung window gets no thumbnail, so one frozen app can't stall the list.
#include <windows.h>
#include <dwmapi.h>
#include <tlhelp32.h>
#include <wincodec.h>

#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "windowscodecs.lib")

static const DWORD REFRESH_MS = 2000;
static const int THUMB_BOX = 200;  // thumbnails fit in this square, physical pixels
static const size_t MAX_SOURCES = 50;
static const int MAX_TITLE = 200;

static HANDLE out = INVALID_HANDLE_VALUE;
static IWICImagingFactory* wic = nullptr;

// The parent closing the pipe (the picker closed) ends the process.
static void writeOut(const std::string& text) {
  const char* bytes = text.data();
  DWORD size = DWORD(text.size());
  while (size) {
    DWORD written = 0;
    if (!WriteFile(out, bytes, size, &written, nullptr) || !written) ExitProcess(0);
    bytes += written;
    size -= written;
  }
}

static DWORD parentPid() {
  DWORD self = GetCurrentProcessId(), parent = 0;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry = {sizeof(entry)};
  for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
    if (entry.th32ProcessID == self) {
      parent = entry.th32ParentProcessID;
      break;
    }
  }
  CloseHandle(snapshot);
  return parent;
}

static std::string utf8(const wchar_t* text) {
  int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(size - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), size, nullptr, nullptr);
  return result;
}

static std::string jsonString(const std::string& text) {
  std::string result = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') {
      result += '\\';
      result += char(c);
    } else if (c < 0x20) {
      char escaped[8];
      snprintf(escaped, sizeof(escaped), "\\u%04x", c);
      result += escaped;
    } else {
      result += char(c);
    }
  }
  return result + "\"";
}

static std::string base64(const std::vector<BYTE>& data) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve((data.size() + 2) / 3 * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    UINT32 n = UINT32(data[i]) << 16 | (i + 1 < data.size() ? UINT32(data[i + 1]) << 8 : 0) | (i + 2 < data.size() ? data[i + 2] : 0);
    result += table[n >> 18 & 63];
    result += table[n >> 12 & 63];
    result += i + 1 < data.size() ? table[n >> 6 & 63] : '=';
    result += i + 2 < data.size() ? table[n & 63] : '=';
  }
  return result;
}

// A 32-bit top-down DIB section the size of the thumbnail, for drawing into and encoding.
struct Thumb {
  HDC dc = nullptr;
  HBITMAP bitmap = nullptr;
  HGDIOBJ old = nullptr;
  void* bits = nullptr;
  int width = 0, height = 0;
  Thumb(HDC like, int w, int h) : width(w), height(h) {
    BITMAPINFO info = {};
    info.bmiHeader = {sizeof(BITMAPINFOHEADER), w, -h, 1, 32, BI_RGB};
    dc = CreateCompatibleDC(like);
    bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    old = SelectObject(dc, bitmap);
    SetStretchBltMode(dc, HALFTONE);
    SetBrushOrgEx(dc, 0, 0, nullptr);
  }
  ~Thumb() {
    SelectObject(dc, old);
    DeleteObject(bitmap);
    DeleteDC(dc);
  }
};

static void fit(int width, int height, int* w, int* h) {
  double scale = double(THUMB_BOX) / (width > height ? width : height);
  if (scale > 1) scale = 1;
  *w = width * scale < 1 ? 1 : int(width * scale);
  *h = height * scale < 1 ? 1 : int(height * scale);
}

// JPEG through WIC, as a data URL, or "null" if anything fails.
static std::string encode(const Thumb& thumb) {
  if (!wic || !thumb.bits) return "null";
  std::string result = "null";
  IWICBitmap* bitmap = nullptr;
  IStream* stream = nullptr;
  IWICBitmapEncoder* encoder = nullptr;
  IWICBitmapFrameEncode* frame = nullptr;
  UINT stride = UINT(thumb.width) * 4;
  if (SUCCEEDED(wic->CreateBitmapFromMemory(thumb.width, thumb.height, GUID_WICPixelFormat32bppBGR, stride, stride * thumb.height, static_cast<BYTE*>(thumb.bits), &bitmap)) &&
      SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) && SUCCEEDED(wic->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder)) &&
      SUCCEEDED(encoder->Initialize(stream, WICBitmapEncoderNoCache)) && SUCCEEDED(encoder->CreateNewFrame(&frame, nullptr)) && SUCCEEDED(frame->Initialize(nullptr)) &&
      SUCCEEDED(frame->WriteSource(bitmap, nullptr)) && SUCCEEDED(frame->Commit()) && SUCCEEDED(encoder->Commit())) {
    HGLOBAL memory = nullptr;
    if (SUCCEEDED(GetHGlobalFromStream(stream, &memory))) {
      STATSTG stat = {};
      stream->Stat(&stat, STATFLAG_NONAME);
      const BYTE* data = static_cast<const BYTE*>(GlobalLock(memory));
      if (data) {
        result = "\"data:image/jpeg;base64," + base64(std::vector<BYTE>(data, data + stat.cbSize.QuadPart)) + "\"";
        GlobalUnlock(memory);
      }
    }
  }
  if (frame) frame->Release();
  if (encoder) encoder->Release();
  if (stream) stream->Release();
  if (bitmap) bitmap->Release();
  return result;
}

static std::string screenThumbnail(const RECT& r) {
  HDC screen = GetDC(nullptr);
  int w, h;
  fit(r.right - r.left, r.bottom - r.top, &w, &h);
  std::string result = "null";
  {
    Thumb thumb(screen, w, h);
    if (StretchBlt(thumb.dc, 0, 0, w, h, screen, r.left, r.top, r.right - r.left, r.bottom - r.top, SRCCOPY | CAPTUREBLT)) result = encode(thumb);
  }
  ReleaseDC(nullptr, screen);
  return result;
}

static std::string windowThumbnail(HWND window, const RECT& frame) {
  RECT rect;
  if (IsIconic(window) || !GetWindowRect(window, &rect) || IsHungAppWindow(window)) return "null";
  int width = rect.right - rect.left, height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return "null";
  HDC screen = GetDC(nullptr);
  std::string result = "null";
  {
    // The whole window first (PW_RENDERFULLCONTENT also gets GPU-drawn content), then the
    // visible frame of it scaled down; the invisible resize borders are left out.
    Thumb full(screen, width, height);
    if (PrintWindow(window, full.dc, PW_RENDERFULLCONTENT)) {
      int fw = frame.right - frame.left, fh = frame.bottom - frame.top, w, h;
      fit(fw, fh, &w, &h);
      Thumb thumb(screen, w, h);
      if (StretchBlt(thumb.dc, 0, 0, w, h, full.dc, frame.left - rect.left, frame.top - rect.top, fw, fh, SRCCOPY)) result = encode(thumb);
    }
  }
  ReleaseDC(nullptr, screen);
  return result;
}

struct Lister {
  DWORD skipPid;
  std::vector<std::string> entries;
};

static BOOL CALLBACK listWindow(HWND window, LPARAM param) {
  Lister* list = reinterpret_cast<Lister*>(param);
  if (list->entries.size() >= MAX_SOURCES) return FALSE;
  if (!IsWindowVisible(window) || GetAncestor(window, GA_ROOT) != window) return TRUE;
  LONG_PTR ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if ((ex & WS_EX_TOOLWINDOW) || (ex & WS_EX_TRANSPARENT)) return TRUE;
  if (GetWindow(window, GW_OWNER) && !(ex & WS_EX_APPWINDOW)) return TRUE;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == list->skipPid || pid == GetCurrentProcessId()) return TRUE;
  wchar_t title[MAX_TITLE + 1];
  if (InternalGetWindowText(window, title, MAX_TITLE + 1) <= 0) return TRUE;
  wchar_t className[64];
  if (GetClassNameW(window, className, 64) && (!wcscmp(className, L"Progman") || !wcscmp(className, L"Shell_TrayWnd"))) return TRUE;
  RECT frame;
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame))) && !GetWindowRect(window, &frame)) return TRUE;
  if (frame.right - frame.left < 2 || frame.bottom - frame.top < 2) return TRUE;
  char id[48];
  snprintf(id, sizeof(id), "window:%llu:0", static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(window)));
  list->entries.push_back("{\"id\":\"" + std::string(id) + "\",\"name\":" + jsonString(utf8(title)) + ",\"thumbnail\":" + windowThumbnail(window, frame) + "}");
  return TRUE;
}

static std::string listSources(DWORD skipPid) {
  Lister list = {skipPid, {}};
  // Screens, numbered the way Chromium numbers them.
  std::vector<std::pair<int, RECT>> screens;
  DISPLAY_DEVICEW device = {sizeof(device)};
  for (DWORD index = 0; EnumDisplayDevicesW(nullptr, index, &device, 0); index++, device = {sizeof(device)}) {
    if (!(device.StateFlags & DISPLAY_DEVICE_ACTIVE)) continue;
    DEVMODEW mode = {};
    mode.dmSize = sizeof(mode);
    if (!EnumDisplaySettingsExW(device.DeviceName, ENUM_CURRENT_SETTINGS, &mode, 0)) continue;
    RECT r = {mode.dmPosition.x, mode.dmPosition.y, mode.dmPosition.x + LONG(mode.dmPelsWidth), mode.dmPosition.y + LONG(mode.dmPelsHeight)};
    screens.push_back({int(index), r});
  }
  for (size_t i = 0; i < screens.size(); i++) {
    char id[32], name[32];
    snprintf(id, sizeof(id), "screen:%d:0", screens[i].first);
    if (screens.size() == 1) snprintf(name, sizeof(name), "Entire screen");
    else snprintf(name, sizeof(name), "Screen %zu", i + 1);
    list.entries.push_back("{\"id\":\"" + std::string(id) + "\",\"name\":\"" + name + "\",\"thumbnail\":" + screenThumbnail(screens[i].second) + "}");
  }
  EnumWindows(listWindow, reinterpret_cast<LPARAM>(&list));
  std::string line = "{\"sources\":[";
  for (size_t i = 0; i < list.entries.size(); i++) line += (i ? "," : "") + list.entries[i];
  return line + "]}\n";
}

int wmain() {
  out = GetStdHandle(STD_OUTPUT_HANDLE);
  _setmode(_fileno(stderr), _O_BINARY);
  // Physical pixels, so screen thumbnails cover whole monitors.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic));
  }
  const DWORD skip = parentPid();
  fputs("ready\n", stderr);
  fflush(stderr);
  for (;;) {
    writeOut(listSources(skip));
    Sleep(REFRESH_MS);
  }
}
