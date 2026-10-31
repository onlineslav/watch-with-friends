// win-app-audio <hwnd>
// win-app-audio --pid <pid>
//
// The Windows twin of native/mac-app-audio: captures audio from only the application that owns
// the given window (an HWND, matching desktopCapturer's `window:<hwnd>:<n>` source id) and its
// child processes, using WASAPI's process loopback (Windows 10 2004+, the same API Discord and
// OBS use for per-app audio). Writes raw interleaved Float32 PCM, stereo at SAMPLE_RATE, to
// stdout as a continuous byte stream. Status/errors go to stderr as one line each ("ready", or
// "error: ..."); main/app-audio.js reads the first line to know whether capture started, and
// keeps the last "error:" line as the reason if the process stops later. `--pid` skips the
// window lookup, for testing against a process that has no window.
//
// Process loopback only delivers packets while the app is actually rendering sound, so this
// fills the gaps with silence paced by the wall clock: downstream (a MediaStreamTrackGenerator
// feeding WebRTC) expects one unbroken stream, the way ScreenCaptureKit delivers it on macOS.
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <tlhelp32.h>
#include <wrl/implements.h>

#include <fcntl.h>
#include <io.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <vector>

using Microsoft::WRL::ComPtr;

static const UINT32 SAMPLE_RATE = 48000;
static const UINT32 CHANNELS = 2;
static const UINT32 FLOAT_FRAME_BYTES = CHANNELS * sizeof(float);
// Silence only starts filling in after this long without a packet, so a late packet in the
// middle of real sound is never preceded by inserted zeros.
static const double SILENCE_AFTER_SECONDS = 0.1;
// At most this much silence goes out at once, so a stall (stdout blocked because the app
// stopped pulling) resyncs the clock instead of bursting seconds of zeros afterwards.
static const UINT32 MAX_FILL_FRAMES = SAMPLE_RATE / 10;

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
static void writeOut(const void* data, DWORD size) {
  const BYTE* bytes = static_cast<const BYTE*>(data);
  while (size) {
    DWORD written = 0;
    if (!WriteFile(out, bytes, size, &written, nullptr) || !written) ExitProcess(0);
    bytes += written;
    size -= written;
  }
}

static void writeSilence(UINT32 frames) {
  static std::vector<float> zeros(MAX_FILL_FRAMES * CHANNELS, 0.0f);
  while (frames) {
    UINT32 now = frames < MAX_FILL_FRAMES ? frames : MAX_FILL_FRAMES;
    writeOut(zeros.data(), now * FLOAT_FRAME_BYTES);
    frames -= now;
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

static bool isFrameHost(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  wchar_t path[MAX_PATH];
  DWORD size = MAX_PATH;
  bool result = false;
  if (QueryFullProcessImageNameW(process, 0, path, &size)) {
    const wchar_t* name = wcsrchr(path, L'\\');
    result = _wcsicmp(name ? name + 1 : path, L"ApplicationFrameHost.exe") == 0;
  }
  CloseHandle(process);
  return result;
}

struct FrameChild {
  DWORD frame;
  DWORD app;
};

static BOOL CALLBACK findFrameChild(HWND child, LPARAM param) {
  FrameChild* search = reinterpret_cast<FrameChild*>(param);
  DWORD pid = 0;
  GetWindowThreadProcessId(child, &pid);
  if (pid && pid != search->frame) {
    search->app = pid;
    return FALSE;
  }
  return TRUE;
}

// Store apps' windows belong to ApplicationFrameHost.exe, which makes no sound itself; the app
// is the process behind the CoreWindow hosted inside it.
static DWORD windowPid(HWND window) {
  if (!IsWindow(window)) fail("That window is no longer open.");
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (!pid) fail("Could not find which app owns that window.");
  if (isFrameHost(pid)) {
    FrameChild search = {pid, 0};
    EnumChildWindows(window, findFrameChild, reinterpret_cast<LPARAM>(&search));
    if (search.app) pid = search.app;
  }
  return pid;
}

class Activation : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                                       Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done);
    return S_OK;
  }
};

static ComPtr<IAudioClient> activate(DWORD pid) {
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activation = {};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<Activation> handler = Microsoft::WRL::Make<Activation>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation,
                                           handler.Get(), &operation);
  if (SUCCEEDED(hr) && WaitForSingleObject(handler->done, 10000) != WAIT_OBJECT_0) hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  HRESULT result = E_FAIL;
  ComPtr<IUnknown> unknown;
  if (SUCCEEDED(hr)) hr = operation->GetActivateResult(&result, &unknown);
  if (SUCCEEDED(hr)) hr = result;
  ComPtr<IAudioClient> client;
  if (SUCCEEDED(hr)) hr = unknown.As(&client);
  if (FAILED(hr)) fail("Windows refused per-app audio capture (0x%08lX). It needs Windows 10 version 2004 or newer.", hr);
  return client;
}

static WAVEFORMATEX format(bool pcm16) {
  WAVEFORMATEX wave = {};
  wave.wFormatTag = pcm16 ? WAVE_FORMAT_PCM : WAVE_FORMAT_IEEE_FLOAT;
  wave.nChannels = CHANNELS;
  wave.nSamplesPerSec = SAMPLE_RATE;
  wave.wBitsPerSample = pcm16 ? 16 : 32;
  wave.nBlockAlign = wave.nChannels * wave.wBitsPerSample / 8;
  wave.nAvgBytesPerSec = wave.nSamplesPerSec * wave.nBlockAlign;
  return wave;
}

int wmain(int argc, wchar_t** argv) {
  out = GetStdHandle(STD_OUTPUT_HANDLE);
  _setmode(_fileno(stderr), _O_BINARY);  // plain "\n" line ends, same as the Mac helper
  DWORD pid = 0;
  if (argc == 3 && wcscmp(argv[1], L"--pid") == 0) {
    pid = wcstoul(argv[2], nullptr, 10);
  } else if (argc == 2) {
    wchar_t* end = nullptr;
    unsigned long long handle = wcstoull(argv[1], &end, 10);
    if (!handle || *end) fail("usage: win-app-audio <hwnd> | --pid <pid>");
    pid = windowPid(reinterpret_cast<HWND>(static_cast<UINT_PTR>(handle)));
  }
  if (!pid) fail("usage: win-app-audio <hwnd> | --pid <pid>");
  // The window is this app's own: capturing it would send everyone's own voices and reactions back.
  if (pid == parentPid() || pid == GetCurrentProcessId()) {
    fail("That's Watch With Friends' own window. Its sound would echo everyone back; share another window, or pick System audio in Settings.");
  }

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) fail("Could not start COM.");
  ComPtr<IAudioClient> client = activate(pid);
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  const REFERENCE_TIME bufferDuration = 2000000;  // 200ms, in 100ns units
  bool pcm16 = false;
  WAVEFORMATEX wave = format(false);
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, bufferDuration, 0, &wave, nullptr);
  if (FAILED(hr)) {
    // Older builds only accept integer PCM here; a fresh client is needed after a failed Initialize.
    client = activate(pid);
    pcm16 = true;
    wave = format(true);
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, bufferDuration, 0, &wave, nullptr);
  }
  if (FAILED(hr)) fail("Could not set up audio capture for that app (0x%08lX).", hr);

  HANDLE packetReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ComPtr<IAudioCaptureClient> capture;
  if (FAILED(client->SetEventHandle(packetReady)) || FAILED(client->GetService(IID_PPV_ARGS(&capture)))) {
    fail("Could not set up audio capture for that app.");
  }
  if (FAILED(client->Start())) fail("Could not start capturing that app's audio.");
  // Without SYNCHRONIZE access (an elevated app, say) the exit just isn't noticed here; the
  // shared window closing still ends the share.
  HANDLE target = OpenProcess(SYNCHRONIZE, FALSE, pid);
  fputs("ready\n", stderr);
  fflush(stderr);

  LARGE_INTEGER frequency, start, now;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&start);
  UINT64 clockFrames = 0;
  double lastPacket = 0;
  std::vector<float> converted;
  HANDLE waits[2] = {packetReady, target};
  for (;;) {
    DWORD woke = WaitForMultipleObjects(target ? 2 : 1, waits, FALSE, 10);
    if (woke == WAIT_OBJECT_0 + 1) fail("The shared app closed.");
    QueryPerformanceCounter(&now);
    double elapsed = double(now.QuadPart - start.QuadPart) / double(frequency.QuadPart);

    UINT32 packet = 0;
    for (;;) {
      hr = capture->GetNextPacketSize(&packet);
      if (FAILED(hr)) fail("Audio capture stopped (0x%08lX).", hr);
      if (!packet) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      hr = capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr);
      if (FAILED(hr)) fail("Audio capture stopped (0x%08lX).", hr);
      if (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
        writeSilence(frames);
      } else if (pcm16) {
        converted.resize(size_t(frames) * CHANNELS);
        const INT16* samples = reinterpret_cast<const INT16*>(data);
        for (size_t i = 0; i < converted.size(); i++) converted[i] = samples[i] / 32768.0f;
        writeOut(converted.data(), frames * FLOAT_FRAME_BYTES);
      } else {
        writeOut(data, frames * FLOAT_FRAME_BYTES);
      }
      capture->ReleaseBuffer(frames);
      clockFrames += frames;
      lastPacket = elapsed;
    }

    UINT64 due = UINT64(elapsed * SAMPLE_RATE);
    if (elapsed - lastPacket >= SILENCE_AFTER_SECONDS && due > clockFrames) {
      UINT64 behind = due - clockFrames;
      writeSilence(UINT32(behind < MAX_FILL_FRAMES ? behind : MAX_FILL_FRAMES));
      clockFrames = due;
    }
  }
}
