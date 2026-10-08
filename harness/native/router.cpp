// Native port of the negotiation loop of src/router/board-router.js (adapter repository) for the
// evaluation settings (rules: null -> every track and via is one cell). The rasterization (pad
// ownership, terminal cells) and the net order come from the JS router (options.rasterOnly), so
// the grid is identical; this program reproduces the rounds, the A* search (same binary heap, same
// neighbour order, same float types) and the statistics bit for bit (lib/native-router.mjs checks).
//
// Input (binary, little endian), path in argv[1]:
//   int32  W, H, L, netCount, orderCount, maxRounds, incremental, margin
//   double cell, viaCost, presentFactor, presentGrowth, historyGain, deadlineS (<= 0: none), astarWeight
//   int32  layerHeuristic (1: A* adds viaCost x layers to the target pad's layer range; not bit-identical to JS)
//   int32  emitPaths (1: output "paths": per routed connection [net, [cell ids in the JS numbering l * P + q]])
//   int32  emitOverflow (1: output "ovf1" / "ovfEnd": overflowing cells (JS numbering) after round 1 / at the end)
//   int32  cleanup (0: off; k > 0: after negotiation, rip up every net that is not clean and reroute
//          them one by one with the clean nets as hard obstacles, trying k net orders; see below)
//   int32  owner[W*H*L]
//   int32  order[orderCount]
//   int32  padCount; per pad: double cx, cy; int32 n; int32 cells[n]
//   per net (netCount): int32 n; int32 pads[n]
// Output (stdout, JSON): rounds, overflow, nets, complete, clean, vias, viaSites, length, seconds,
//   roundLog, status[], netVias[], netLen[] (mm)
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cmath>
#include <vector>
#include <chrono>
#include <string>
#include <algorithm>

using std::vector;

struct MinHeap {
  vector<double> k; vector<int32_t> v; int n = 0;
  MinHeap() : k(1 << 16), v(1 << 16) {}
  void push(double key, int32_t val) {
    if (n == (int)k.size()) { k.resize(n * 2); v.resize(n * 2); }
    int i = n++;
    while (i > 0) { int p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  int32_t pop() {
    int32_t top = v[0]; double key = k[--n]; int32_t val = v[n];
    int i = 0;
    for (;;) {
      int c = 2 * i + 1; if (c >= n) break;
      if (c + 1 < n && k[c + 1] < k[c]) c++;
      if (k[c] >= key) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = key; v[i] = val;
    return top;
  }
};

// bad: cleanup could not route this net without conflicts; its paths (soft route) count for vias and
// length, but its cells are not committed, so it never makes another net unclean.
struct Route { bool complete = true; bool has = false; bool bad = false; vector<int32_t> cells; vector<vector<int32_t>> paths; };

static FILE* in;
template <class T> T rd() { T x; if (fread(&x, sizeof(T), 1, in) != 1) { fprintf(stderr, "short input\n"); exit(2); } return x; }
template <class T> void rdv(vector<T>& a, size_t n) { a.resize(n); if (n && fread(a.data(), sizeof(T), n, in) != n) { fprintf(stderr, "short input\n"); exit(2); } }

int main(int argc, char** argv) {
  auto t0 = std::chrono::steady_clock::now();
  if (argc < 2 || !(in = fopen(argv[1], "rb"))) { fprintf(stderr, "usage: router input.bin\n"); return 2; }
  const int W = rd<int32_t>(), H = rd<int32_t>(), L = rd<int32_t>(), netCount = rd<int32_t>(), orderCount = rd<int32_t>();
  const int maxRounds = rd<int32_t>(), incremental = rd<int32_t>(), margin = rd<int32_t>();
  const double cell = rd<double>(), viaCost = rd<double>(), presentFactor = rd<double>(), presentGrowth = rd<double>(), historyGain = rd<double>(), deadlineS = rd<double>(), AW = rd<double>();
  const int layerH = rd<int32_t>(), emitPaths = rd<int32_t>(), emitOverflow = rd<int32_t>(), cleanup = rd<int32_t>();
  const int P = W * H, N = L * P, BOTTOM = L - 1, WL = W * L;
  vector<int32_t> ownerJs, order; rdv(ownerJs, N); rdv(order, orderCount);
  // Internal cell index q * L + l (JS: l * P + q): the layers of one grid position are adjacent in
  // memory, so a via step (+-1) stays in cache. Heap keys do not depend on cell ids, so results are
  // unchanged. Per-cell data packed by access pattern.
  auto toInt = [&](int32_t c) { int l = c / P; return (c - l * P) * L + l; };
  struct CellS { int32_t owner; float hist; uint16_t usage; };
  struct SearchS { double g; int32_t gen; int32_t from; };
  vector<CellS> cs(N);
  for (int c = 0; c < N; c++) cs[toInt(c)] = { ownerJs[c], 0.f, 0 };
  vector<int32_t>().swap(ownerJs);
  const int padCount = rd<int32_t>();
  vector<double> pcx(padCount), pcy(padCount); vector<vector<int32_t>> padCells(padCount);
  for (int i = 0; i < padCount; i++) { pcx[i] = rd<double>(); pcy[i] = rd<double>(); int n = rd<int32_t>(); rdv(padCells[i], n); for (auto& c : padCells[i]) c = toInt(c); }
  vector<vector<int32_t>> netPads(netCount);
  for (int i = 0; i < netCount; i++) { int n = rd<int32_t>(); rdv(netPads[i], n); }
  fclose(in);

  vector<SearchS> ss(N, SearchS{0, 0, 0}); vector<int32_t> mark(N, 0);
  vector<int32_t> treeGen(N, 0), takenGen(N, 0);
  int curGen = 0, markGen = 0, treeStamp = 0, takenStamp = 0;
  MinHeap heap;
  double pres = presentFactor;
  const double tb = 1.0; // track block size (rules: null)
  bool hard = false; // cleanup: cells used by another net are blocked

  int tl0 = 0, tl1 = 0; // target pad layer range (layerHeuristic)
  // Layer term of the heuristic: every layer change costs >= viaCost, so it stays admissible and consistent.
  auto hl = [&](int l) -> double { return !layerH ? 0.0 : l < tl0 ? viaCost * (tl0 - l) : l > tl1 ? viaCost * (l - tl1) : 0.0; };
  auto search = [&](int net, const vector<int32_t>& sources, int targetMark, int tx, int ty, int wx0, int wy0, int wx1, int wy1) -> int32_t {
    curGen++;
    heap.n = 0;
    for (int32_t s : sources) { ss[s] = { 0, curGen, -1 }; int q = s / L; double h = std::abs(q % W - tx) + std::abs(q / W - ty); if (layerH) h += hl(s - q * L); heap.push(AW == 1 ? h : AW * h, s); }
    int32_t nb[6], nx[6], ny[6]; double nbase[6];
    while (heap.n) {
      const int32_t c = heap.pop();
      if (mark[c] == targetMark) return c;
      const double gc = ss[c].g;
      const int q = c / L, l = c - q * L, x = q % W, y = q / W;
      int k = 0;
      if (x > wx0) { nb[k] = c - L; nx[k] = x - 1; ny[k] = y; nbase[k++] = 1; }
      if (x < wx1) { nb[k] = c + L; nx[k] = x + 1; ny[k] = y; nbase[k++] = 1; }
      if (y > wy0) { nb[k] = c - WL; nx[k] = x; ny[k] = y - 1; nbase[k++] = 1; }
      if (y < wy1) { nb[k] = c + WL; nx[k] = x; ny[k] = y + 1; nbase[k++] = 1; }
      if (l > 0) { nb[k] = c - 1; nx[k] = x; ny[k] = y; nbase[k++] = viaCost * tb; }
      if (l < BOTTOM) { nb[k] = c + 1; nx[k] = x; ny[k] = y; nbase[k++] = viaCost * tb; }
      for (int j = 0; j < k; j++) {
        const int32_t n = nb[j]; const CellS& cn = cs[n];
        if (cn.owner != -1 && cn.owner != net) continue;
        if (hard && cn.usage) continue;
        const double use = cn.usage, hist = cn.hist;
        const double ng = gc + nbase[j] * (1 + hist) * (1 + pres * use);
        SearchS& sn = ss[n];
        if (sn.gen == curGen && sn.g <= ng) continue;
        sn = { ng, curGen, c };
        // Same association as the JS key: (ng + |dx|) + |dy| (reassociating changes results).
        const double dx = std::abs(nx[j] - tx), dy = std::abs(ny[j] - ty);
        if (layerH) { const double h = dx + dy + hl(n - (n / L) * L); heap.push(AW == 1 ? ng + h : ng + AW * h, n); }
        else heap.push(AW == 1 ? ng + dx + dy : ng + AW * (dx + dy), n);
      }
    }
    return -1;
  };

  vector<int32_t> tree; // inTree in insertion order (JS Set iteration order)
  auto routeNet = [&](int net) {
    Route r; r.has = true;
    const vector<int32_t>& pads = netPads[net];
    if (pads.size() < 2) return r;
    treeStamp++; takenStamp++; tree.clear();
    auto addTree = [&](int32_t c) { if (treeGen[c] != treeStamp) { treeGen[c] = treeStamp; tree.push_back(c); } };
    for (int32_t c : padCells[pads[0]]) addTree(c);
    vector<int32_t> connected{pads[0]}, remaining(pads.begin() + 1, pads.end());
    while (!remaining.empty()) {
      size_t bi = 0; double bd = INFINITY;
      for (size_t k = 0; k < remaining.size(); k++) { int p = remaining[k]; for (int q : connected) { double d = std::abs(pcx[p] - pcx[q]) + std::abs(pcy[p] - pcy[q]); if (d < bd) { bd = d; bi = k; } } }
      const int target = remaining[bi]; remaining.erase(remaining.begin() + bi);
      markGen++; tl0 = L; tl1 = -1; for (int32_t c : padCells[target]) { mark[c] = markGen; int l = c % L; tl0 = std::min(tl0, l); tl1 = std::max(tl1, l); }
      const int tx = std::min(W - 1, std::max(0, (int)std::floor(pcx[target] / cell))), ty = std::min(H - 1, std::max(0, (int)std::floor(pcy[target] / cell)));
      int x0 = tx, y0 = ty, x1 = tx, y1 = ty;
      for (int32_t c : tree) { int q = c / L, x = q % W, y = q / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      int32_t hit = search(net, tree, markGen, tx, ty, std::max(0, x0 - margin), std::max(0, y0 - margin), std::min(W - 1, x1 + margin), std::min(H - 1, y1 + margin));
      if (hit < 0) hit = search(net, tree, markGen, tx, ty, 0, 0, W - 1, H - 1);
      if (hit < 0) { r.complete = false; continue; }
      vector<int32_t> path;
      for (int32_t c = hit; c >= 0; c = ss[c].from) path.push_back(c);
      std::reverse(path.begin(), path.end());
      for (int32_t c : path) {
        if (treeGen[c] == treeStamp) continue;
        addTree(c);
        if (cs[c].owner == -1 && takenGen[c] != takenStamp) { takenGen[c] = takenStamp; r.cells.push_back(c); }
      }
      r.paths.push_back(std::move(path));
      for (int32_t c : padCells[target]) addTree(c);
      connected.push_back(target);
    }
    return r;
  };

  vector<Route> routes(netCount);
  int rounds = 0, overflow = 0; double prevOverflow = INFINITY; bool fullRound = true;
  std::string roundLog = "[";
  auto toJs = [&](int c) { int q = c / L, l = c - q * L; return l * P + q; };
  auto overflowCells = [&]() { std::string o = "["; bool f = true; for (int c = 0; c < N; c++) if (cs[c].usage > 1) { o += (f ? "" : ",") + std::to_string(toJs(c)); f = false; } return o + "]"; };
  std::string ovf1 = "[]";
  for (int round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    for (int n : order) {
      Route& old = routes[n];
      if (incremental && !fullRound && old.has && old.complete) {
        bool over = false; for (int32_t c : old.cells) if (cs[c].usage > 1) { over = true; break; }
        if (!over) continue;
      }
      if (old.has) for (int32_t c : old.cells) cs[c].usage--;
      routes[n] = routeNet(n);
      for (int32_t c : routes[n].cells) cs[c].usage++;
    }
    if (round == 0 && emitOverflow) ovf1 = overflowCells();
    overflow = 0;
    for (int c = 0; c < N; c++) if (cs[c].usage > 1) { overflow++; cs[c].hist = (float)(cs[c].hist + historyGain * (cs[c].usage - 1)); }
    double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    roundLog += (round ? "," : "") + std::string("{\"round\":") + std::to_string(rounds) + ",\"overflow\":" + std::to_string(overflow) + ",\"s\":" + std::to_string(el) + "}";
    if (deadlineS > 0 && el > deadlineS) break;
    if (!overflow) break;
    fullRound = overflow >= prevOverflow; prevOverflow = overflow;
    pres *= presentGrowth;
  }
  roundLog += "]";
  const std::string ovfEnd = emitOverflow ? overflowCells() : "[]";

  // Cleanup. Negotiation ends with a few overflowing cells, and every net crossing one counts as not
  // clean; which nets lose depends on grid phase and order (router noise). Rip up all nets that are
  // not clean (overflow or open), keep the clean ones as hard obstacles and route the ripped nets
  // one at a time on free cells only, in `cleanup` orders (span ascending, descending, then seeded
  // shuffles); keep the order with most nets routed (then fewest vias). A net that still fails gets
  // a soft route (negotiated costs) for its vias / length, marked bad and not committed.
  int cleanupNets = 0, cleanupRecovered = 0, cleanupOrder = -1;
  if (cleanup > 0) {
    vector<int> badNets;
    for (int n : order) {
      Route& r = routes[n];
      bool ok = r.complete; if (ok) for (int32_t c : r.cells) if (cs[c].usage > 1) { ok = false; break; }
      if (!ok) badNets.push_back(n);
    }
    cleanupNets = (int)badNets.size();
    if (!badNets.empty()) {
      for (int n : badNets) { for (int32_t c : routes[n].cells) cs[c].usage--; routes[n] = Route(); }
      vector<uint16_t> base(N); for (int c = 0; c < N; c++) base[c] = cs[c].usage;
      vector<Route> best; int bestOk = -1; long bestVias = 0;
      uint32_t rs = 12345;
      auto rnd = [&]() { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; };
      auto viasOf = [&](const Route& r) { long v = 0; for (const auto& p : r.paths) for (size_t k = 1; k < p.size(); k++) if (std::abs(p[k] - p[k - 1]) == 1) v++; return v; };
      for (int k = 0; k < cleanup; k++) {
        vector<int> ord = badNets;
        if (k == 1) std::reverse(ord.begin(), ord.end());
        else if (k > 1) for (size_t i = ord.size() - 1; i > 0; i--) std::swap(ord[i], ord[rnd() % (i + 1)]);
        for (int c = 0; c < N; c++) cs[c].usage = base[c];
        vector<Route> cur(netCount); int ok = 0; long vias = 0;
        hard = true;
        for (int n : ord) { Route r = routeNet(n); if (r.complete) { ok++; vias += viasOf(r); for (int32_t c : r.cells) cs[c].usage++; } else r.bad = true; cur[n] = std::move(r); }
        hard = false;
        if (ok > bestOk || (ok == bestOk && vias < bestVias)) { bestOk = ok; bestVias = vias; best = std::move(cur); cleanupOrder = k; }
      }
      for (int c = 0; c < N; c++) cs[c].usage = base[c];
      for (int n : badNets) if (!best[n].bad) for (int32_t c : best[n].cells) cs[c].usage++;
      for (int n : badNets) {
        if (best[n].bad) { Route r = routeNet(n); r.bad = true; routes[n] = std::move(r); }
        else routes[n] = std::move(best[n]);
      }
      cleanupRecovered = bestOk;
    }
  }

  int clean = 0, complete = 0; long vias = 0, viaSites = 0; double length = 0;
  vector<int> status(netCount, 0), netVias(netCount, 0); vector<double> netLen(netCount, 0);
  for (int n : order) {
    const Route& r = routes[n];
    bool isClean = r.complete && !r.bad; if (isClean) for (int32_t c : r.cells) if (cs[c].usage > 1) { isClean = false; break; }
    status[n] = isClean ? 1 : r.complete ? 2 : 3;
    if (r.complete) complete++;
    if (isClean) clean++;
    for (const auto& path : r.paths) for (size_t k = 1; k < path.size(); k++) {
      if (std::abs(path[k] - path[k - 1]) == 1) { vias++; netVias[n]++; if (!(k > 1 && std::abs(path[k - 1] - path[k - 2]) == 1)) viaSites++; }
      else { length += cell; netLen[n] += cell; }
    }
  }
  double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  printf("{\"rounds\":%d,\"overflow\":%d,\"nets\":%d,\"complete\":%d,\"clean\":%d,\"vias\":%ld,\"viaSites\":%ld,\"length\":%.10g,\"seconds\":%.3f,\"roundLog\":%s,\"cleanup\":{\"nets\":%d,\"recovered\":%d,\"order\":%d},\"status\":[", rounds, overflow, orderCount, complete, clean, vias, viaSites, length, secs, roundLog.c_str(), cleanupNets, cleanupRecovered, cleanupOrder);
  for (int i = 0; i < netCount; i++) printf(i ? ",%d" : "%d", status[i]);
  if (emitOverflow) printf("],\"ovf1\":%s,\"ovfEnd\":%s,\"netVias\":[", ovf1.c_str(), ovfEnd.c_str()); else
  printf("],\"netVias\":[");
  for (int i = 0; i < netCount; i++) printf(i ? ",%d" : "%d", netVias[i]);
  printf("],\"netLen\":[");
  for (int i = 0; i < netCount; i++) printf(i ? ",%.6g" : "%.6g", netLen[i]);
  printf("]");
  if (emitPaths) {
    printf(",\"paths\":[");
    bool first = true;
    for (int n : order) for (const auto& path : routes[n].paths) {
      printf(first ? "[%d,[" : ",[%d,[", n); first = false;
      for (size_t k = 0; k < path.size(); k++) { int q = path[k] / L, l = path[k] - q * L; printf(k ? ",%d" : "%d", l * P + q); }
      printf("]]");
    }
    printf("]");
  }
  printf("}\n");
  return 0;
}
