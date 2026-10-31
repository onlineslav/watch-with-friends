// win-app-windows <hwnd>
//
// Reports where one application's windows are, so a share can show all of them — the plugin
// windows and dialogs a DAW opens beside its main window, say — and nothing else. The app is the
// process that owns the given window (an HWND, matching desktopCapturer's `window:<hwnd>:<n>`
// source id) plus its child processes, the same process tree native/win-app-audio captures, and
// any window owned by one of those (a plugin bridge can live in an unrelated process).
//
// Writes one JSON line to stdout whenever the layout changes, in physical pixels:
//   {"desktop":[x,y,w,h],"windows":[[x,y,w,h,hwnd],...]}
// `desktop` is the virtual screen (every monitor); `windows` are the app's visible top-level
// windows, topmost first, with their visible frame (what a window capture of that HWND shows).
// The renderer captures each of those windows on its own and lays them out the same way, so a
// window from another app on top of them never hides or leaks into the share.
// Status/errors go to stderr as one line each, like win-app-audio ("ready", or "error: ...").
//
// Event-driven: WinEvent hooks wake it when any window moves, appears, hides or changes order,
// and it rescans at most every MIN_SCAN_MS, so a dragged plugin window's position follows at
// display rate while a still desktop costs nothing. A slow timer catches anything no event
// reports (and refreshes the process tree).
#include <windows.h>
#include <dwmapi.h>
#include <tlhelp32.h>

#include <fcntl.h>
#include <io.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

static const DWORD MIN_SCAN_MS = 8;
static const DWORD SLOW_SCAN_MS = 1000;
// Plenty for any real app; a runaway count can't grow the line without bound.
static const size_t MAX_WINDOWS = 64;

[[noreturn]] static void fail(const char* format, ...) {
  va_list args;
  va_start(args, format);
  fputs("error: ", stderr);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  va_end(args);
  fflush(stderr);
  ExitProcess(1);
}

static HANDLE out = INVALID_HANDLE_VALUE;

// The parent closing the pipe (the share stopped, or the app quit) ends the process.
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

// The target and every process it started, directly or not.
static std::set<DWORD> processTree(DWORD root) {
  std::unordered_map<DWORD, std::vector<DWORD>> children;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W entry = {sizeof(entry)};
    for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
      if (entry.th32ProcessID != entry.th32ParentProcessID) children[entry.th32ParentProcessID].push_back(entry.th32ProcessID);
    }
    CloseHandle(snapshot);
  }
  std::set<DWORD> tree = {root};
  std::vector<DWORD> pending = {root};
  while (!pending.empty()) {
    DWORD pid = pending.back();
    pending.pop_back();
    for (DWORD child : children[pid]) {
      if (tree.insert(child).second) pending.push_back(child);
    }
  }
  return tree;
}

static DWORD windowPid(HWND window) {
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  return pid;
}

static bool belongs(HWND window, const std::set<DWORD>& tree) {
  for (int depth = 0; window && depth < 16; depth++, window = GetWindow(window, GW_OWNER)) {
    if (tree.count(windowPid(window))) return true;
  }
  return false;
}

// What's actually on screen: shown, not minimized, not cloaked (a window on another virtual
// desktop, or a suspended Store app, is "visible" but not drawn), with its visible frame rather
// than GetWindowRect's, which includes invisible resize borders around every window. The visible
// frame is also exactly what a window capture of it delivers.
static bool shownRect(HWND window, RECT* rect) {
  if (!IsWindowVisible(window) || IsIconic(window)) return false;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return false;
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, rect, sizeof(*rect))) && !GetWindowRect(window, rect)) return false;
  return rect->right > rect->left && rect->bottom > rect->top;
}

struct Placed {
  RECT rect;
  HWND window;
};

struct Scan {
  const std::set<DWORD>* tree;
  std::vector<Placed> windows;
};

static BOOL CALLBACK scanWindow(HWND window, LPARAM param) {
  Scan* scan = reinterpret_cast<Scan*>(param);
  if (scan->windows.size() >= MAX_WINDOWS) return FALSE;
  RECT rect;
  if (belongs(window, *scan->tree) && shownRect(window, &rect)) scan->windows.push_back({rect, window});
  return TRUE;
}

static std::string layout(const std::set<DWORD>& tree) {
  Scan scan = {&tree, {}};
  EnumWindows(scanWindow, reinterpret_cast<LPARAM>(&scan));  // topmost first
  char part[128];
  snprintf(part, sizeof(part), "{\"desktop\":[%d,%d,%d,%d],\"windows\":[", GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
           GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
  std::string line = part;
  for (size_t i = 0; i < scan.windows.size(); i++) {
    const RECT& r = scan.windows[i].rect;
    snprintf(part, sizeof(part), "%s[%ld,%ld,%ld,%ld,%llu]", i ? "," : "", r.left, r.top, r.right - r.left, r.bottom - r.top,
             static_cast<unsigned long long>(reinterpret_cast<UINT_PTR>(scan.windows[i].window)));
    line += part;
  }
  return line + "]}\n";
}

static HWND target_ = nullptr;
static DWORD pid_ = 0;
static std::set<DWORD> tree_;
static std::string last_;
static ULONGLONG scannedAt_ = 0;
static UINT_PTR pendingTimer_ = 0;

static void scan() {
  if (!IsWindow(target_)) fail("The shared window closed.");
  scannedAt_ = GetTickCount64();
  std::string line = layout(tree_);
  if (line != last_) {
    writeOut(line);
    last_ = line;
  }
}

static void CALLBACK pendingScan(HWND, UINT, UINT_PTR id, DWORD) {
  KillTimer(nullptr, id);
  pendingTimer_ = 0;
  scan();
}

// Events come in bursts (a drag moves a window hundreds of times a second): scan straight away
// if the last scan was long enough ago, otherwise once, when it is.
static void scanSoon() {
  ULONGLONG since = GetTickCount64() - scannedAt_;
  if (since >= MIN_SCAN_MS) return scan();
  if (!pendingTimer_) pendingTimer_ = SetTimer(nullptr, 0, UINT(MIN_SCAN_MS - since), pendingScan);
}

// Only the app's own top-level windows change the layout. A destroyed window can't be asked who
// owned it any more, so any destroyed window counts.
static void CALLBACK onEvent(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD) {
  if (!window || object != OBJID_WINDOW || child != CHILDID_SELF) return;
  if (event == EVENT_OBJECT_DESTROY || (GetAncestor(window, GA_ROOT) == window && belongs(window, tree_))) scanSoon();
}

// Plugin hosts and helpers start and stop while the app runs; and a safety net for any change no
// event reported.
static void CALLBACK slowScan(HWND, UINT, UINT_PTR, DWORD) {
  tree_ = processTree(pid_);
  scan();
}

int wmain(int argc, wchar_t** argv) {
  out = GetStdHandle(STD_OUTPUT_HANDLE);
  _setmode(_fileno(stderr), _O_BINARY);  // plain "\n" line ends, same as win-app-audio
  // Physical pixels everywhere, matching what a window capture delivers.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  wchar_t* end = nullptr;
  unsigned long long handle = argc == 2 ? wcstoull(argv[1], &end, 10) : 0;
  if (!handle || *end) fail("usage: win-app-windows <hwnd>");
  HWND target = reinterpret_cast<HWND>(static_cast<UINT_PTR>(handle));
  if (!IsWindow(target)) fail("That window is no longer open.");
  DWORD pid = windowPid(target);
  if (!pid) fail("Could not find which app owns that window.");
  if (pid == parentPid() || pid == GetCurrentProcessId()) fail("That's Watch With Friends' own window; share another window.");

  pid_ = pid;
  target_ = target;
  tree_ = processTree(pid);
  scan();
  fputs("ready\n", stderr);
  fflush(stderr);

  // Out-of-context hooks are delivered to this thread's message loop.
  const DWORD events[][2] = {
      {EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE},  // create, destroy, show, hide
      {EVENT_OBJECT_REORDER, EVENT_OBJECT_REORDER},
      {EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE},
      {EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND},
      {EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND},
      {EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED},
  };
  for (const auto& range : events) {
    if (!SetWinEventHook(range[0], range[1], nullptr, onEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)) fail("Could not watch windows (%lu).", GetLastError());
  }
  SetTimer(nullptr, 0, SLOW_SCAN_MS, slowScan);
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
  return 0;
}
