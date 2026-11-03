// win-net-probe
//
// Pings this computer's router (the default gateway) and the internet (1.1.1.1) every 200ms, for
// as long as it runs, so a stall in a watch session can be placed: router pings slow too means
// this computer's own network (Wi-Fi, cable, router); only the internet ping slow means the line
// past the router; neither means somewhere else (the other person's side, or between). Windows'
// own ping.exe can only ping once a second, which misses half of a one-second stall, hence this.
// IcmpSendEcho needs no administrator rights.
//
// One line per probe on stdout: "gw <ms>" or "net <ms>", with -1 when no reply came within 1s.
// The gateway is looked up again every 30s (a laptop moves between networks); with none (a direct
// connection, or no network at all) there are no "gw" lines. Exits once stdout is closed.
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <icmpapi.h>

#include <chrono>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

using Clock = std::chrono::steady_clock;

constexpr auto INTERVAL = std::chrono::milliseconds(200);
constexpr DWORD TIMEOUT_MS = 1000;
constexpr auto GATEWAY_REFRESH = std::chrono::seconds(30);

static std::mutex outLock;

static void emit(const char* name, long ms) {
  std::lock_guard<std::mutex> lock(outLock);
  if (printf("%s %ld\n", name, ms) < 0 || fflush(stdout) != 0) ExitProcess(0);
}

static IPAddr internet() {
  IN_ADDR addr{};
  inet_pton(AF_INET, "1.1.1.1", &addr);
  return addr.S_un.S_addr;
}

// The next hop towards the internet; 0 when there is none.
static IPAddr gateway() {
  MIB_IPFORWARDROW row{};
  if (GetBestRoute(internet(), 0, &row) != NO_ERROR) return 0;
  return row.dwForwardType == MIB_IPROUTE_TYPE_INDIRECT ? row.dwForwardNextHop : 0;
}

static void probe(const char* name, bool isGateway) {
  HANDLE icmp = IcmpCreateFile();
  if (icmp == INVALID_HANDLE_VALUE) return;
  char payload[32] = "watch-with-friends net probe";
  std::vector<unsigned char> reply(sizeof(ICMP_ECHO_REPLY) + sizeof(payload) + 8);
  IPAddr target = isGateway ? gateway() : internet();
  auto lookedUp = Clock::now();
  auto next = Clock::now();
  for (;;) {
    if (isGateway && Clock::now() - lookedUp >= GATEWAY_REFRESH) {
      target = gateway();
      lookedUp = Clock::now();
    }
    if (target) {
      const auto sent = Clock::now();
      const DWORD replies = IcmpSendEcho(icmp, target, payload, sizeof(payload), nullptr, reply.data(), static_cast<DWORD>(reply.size()), TIMEOUT_MS);
      long ms = -1;
      if (replies > 0 && reinterpret_cast<ICMP_ECHO_REPLY*>(reply.data())->Status == IP_SUCCESS) {
        ms = static_cast<long>(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - sent).count());
      }
      emit(name, ms);
    }
    next += INTERVAL;
    const auto now = Clock::now();
    if (next > now) std::this_thread::sleep_until(next);
    else next = now; // a probe that waited out its timeout: carry on from here, don't burst to catch up
  }
}

int main() {
  std::thread net(probe, "net", false);
  probe("gw", true);
  net.join();
  return 0;
}
