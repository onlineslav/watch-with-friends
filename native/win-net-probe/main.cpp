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
// connection, or no network at all) there are no "gw" lines.
//
// Commands on stdin, one per line (the other people in the room, from main/net-probe.js):
//   peer <id> <ipv4>   ping that address every 200ms too: "p <id> <ms>" (at most 4 at once)
//   peer <id> -        stop pinging it
//   trace <id>         one traceroute to that peer's address, one probe per hop, at most 20 hops:
//                      "hop <id> <ttl> <ms|-1> <address|*>" per hop, then "trace-end <id> <0|1>"
//                      (1 = the address itself answered). Addresses go to main, which hashes them
//                      and never logs them.
// Exits once stdout or stdin is closed.
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <icmpapi.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Clock = std::chrono::steady_clock;

constexpr auto INTERVAL = std::chrono::milliseconds(200);
constexpr DWORD TIMEOUT_MS = 1000;
constexpr DWORD HOP_TIMEOUT_MS = 700;
constexpr int MAX_HOPS = 20;
constexpr int PEER_SLOTS = 4;
constexpr auto GATEWAY_REFRESH = std::chrono::seconds(30);

static std::mutex outLock;
static std::mutex peerLock;

struct Peer {
  std::string id;
  IPAddr address = 0;
  bool tracing = false;
};
static Peer peers[PEER_SLOTS];

static void emitLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(outLock);
  if (printf("%s\n", line.c_str()) < 0 || fflush(stdout) != 0) ExitProcess(0);
}

static void emit(const char* name, long ms) {
  emitLine(std::string(name) + " " + std::to_string(ms));
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

static char payload[32] = "watch-with-friends net probe";

// One echo: ms, or -1 if nothing came back in time.
static long echo(HANDLE icmp, IPAddr target, std::vector<unsigned char>& reply) {
  const auto sent = Clock::now();
  const DWORD replies = IcmpSendEcho(icmp, target, payload, sizeof(payload), nullptr, reply.data(), static_cast<DWORD>(reply.size()), TIMEOUT_MS);
  if (replies > 0 && reinterpret_cast<ICMP_ECHO_REPLY*>(reply.data())->Status == IP_SUCCESS) {
    return static_cast<long>(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - sent).count());
  }
  return -1;
}

static void pace(Clock::time_point& next) {
  next += INTERVAL;
  const auto now = Clock::now();
  if (next > now) std::this_thread::sleep_until(next);
  else next = now; // a probe that waited out its timeout: carry on from here, don't burst to catch up
}

static void probe(const char* name, bool isGateway) {
  HANDLE icmp = IcmpCreateFile();
  if (icmp == INVALID_HANDLE_VALUE) return;
  std::vector<unsigned char> reply(sizeof(ICMP_ECHO_REPLY) + sizeof(payload) + 64);
  IPAddr target = isGateway ? gateway() : internet();
  auto lookedUp = Clock::now();
  auto next = Clock::now();
  for (;;) {
    if (isGateway && Clock::now() - lookedUp >= GATEWAY_REFRESH) {
      target = gateway();
      lookedUp = Clock::now();
    }
    if (target) emit(name, echo(icmp, target, reply));
    pace(next);
  }
}

// One thread per peer slot; an empty slot just waits.
static void probePeer(int slot) {
  HANDLE icmp = IcmpCreateFile();
  if (icmp == INVALID_HANDLE_VALUE) return;
  std::vector<unsigned char> reply(sizeof(ICMP_ECHO_REPLY) + sizeof(payload) + 64);
  auto next = Clock::now();
  for (;;) {
    std::string id;
    IPAddr target = 0;
    {
      std::lock_guard<std::mutex> lock(peerLock);
      id = peers[slot].id;
      target = peers[slot].address;
    }
    if (target) {
      const long ms = echo(icmp, target, reply);
      bool still = false;
      {
        std::lock_guard<std::mutex> lock(peerLock);
        still = peers[slot].id == id && peers[slot].address == target;
      }
      if (still) emitLine("p " + id + " " + std::to_string(ms));
    }
    pace(next);
  }
}

static std::string addressText(IPAddr address) {
  IN_ADDR addr{};
  addr.S_un.S_addr = address;
  char text[INET_ADDRSTRLEN] = {0};
  inet_ntop(AF_INET, &addr, text, sizeof(text));
  return text;
}

static void trace(int slot, std::string id, IPAddr target) {
  HANDLE icmp = IcmpCreateFile();
  bool reached = false;
  if (icmp != INVALID_HANDLE_VALUE) {
    // A TTL-expired reply carries the original header and payload back, so leave room for it.
    std::vector<unsigned char> reply(sizeof(ICMP_ECHO_REPLY) + sizeof(payload) + 256);
    for (int ttl = 1; ttl <= MAX_HOPS && !reached; ttl++) {
      IP_OPTION_INFORMATION options{};
      options.Ttl = static_cast<UCHAR>(ttl);
      const auto sent = Clock::now();
      const DWORD replies = IcmpSendEcho(icmp, target, payload, sizeof(payload), &options, reply.data(), static_cast<DWORD>(reply.size()), HOP_TIMEOUT_MS);
      long ms = -1;
      std::string from = "*";
      if (replies > 0) {
        const auto* r = reinterpret_cast<ICMP_ECHO_REPLY*>(reply.data());
        if (r->Status == IP_SUCCESS || r->Status == IP_TTL_EXPIRED_TRANSIT) {
          ms = static_cast<long>(std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - sent).count());
          from = addressText(r->Address);
          reached = r->Status == IP_SUCCESS;
        }
      }
      emitLine("hop " + id + " " + std::to_string(ttl) + " " + std::to_string(ms) + " " + from);
    }
    IcmpCloseHandle(icmp);
  }
  emitLine("trace-end " + id + " " + (reached ? "1" : "0"));
  std::lock_guard<std::mutex> lock(peerLock);
  if (peers[slot].id == id) peers[slot].tracing = false;
}

static bool validId(const std::string& id) {
  if (id.empty() || id.size() > 64) return false;
  for (char c : id) if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') return false;
  return true;
}

static int slotOf(const std::string& id) {
  for (int i = 0; i < PEER_SLOTS; i++) if (peers[i].id == id) return i;
  return -1;
}

static void command(const std::string& line) {
  char verb[16] = {0}, idText[80] = {0}, arg[64] = {0};
  const int fields = sscanf_s(line.c_str(), "%15s %79s %63s", verb, static_cast<unsigned>(sizeof(verb)), idText, static_cast<unsigned>(sizeof(idText)), arg, static_cast<unsigned>(sizeof(arg)));
  if (fields < 2 || !validId(idText)) return;
  const std::string id = idText;
  std::lock_guard<std::mutex> lock(peerLock);
  if (strcmp(verb, "peer") == 0 && fields == 3) {
    int slot = slotOf(id);
    if (strcmp(arg, "-") == 0) {
      if (slot >= 0) peers[slot] = Peer{};
      return;
    }
    IN_ADDR addr{};
    if (inet_pton(AF_INET, arg, &addr) != 1) return;
    if (slot < 0) slot = slotOf("");
    if (slot < 0) return; // all slots in use
    peers[slot].id = id;
    peers[slot].address = addr.S_un.S_addr;
  } else if (strcmp(verb, "trace") == 0) {
    const int slot = slotOf(id);
    if (slot < 0 || !peers[slot].address || peers[slot].tracing) return;
    peers[slot].tracing = true;
    std::thread(trace, slot, id, peers[slot].address).detach();
  }
}

int main() {
  std::thread(probe, "net", false).detach();
  std::thread(probe, "gw", true).detach();
  for (int i = 0; i < PEER_SLOTS; i++) std::thread(probePeer, i).detach();
  std::string line;
  while (std::getline(std::cin, line)) command(line);
  ExitProcess(0); // stdin closed: main is gone
}
