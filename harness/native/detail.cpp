// Native port of the detail pass of harness/lib/detail.mjs (all cost terms): same random
// stream, same move sequence, same cost terms summed in the same order, so with T0 = 0 and a fixed
// number of tries the result is identical to the JS version (test/harness.test.mjs checks it). With
// T0 > 0 the temperature follows the wall clock, like the JS version.
//
// Input (binary, little endian), path in argv[1] (written by harness/lib/detail.mjs):
//   int32  n, netCount, pinCount, padCount, decapCount, seed
//   double W, H, clearance, nu, T0, relocate, budgetS, gap, kappa, decapFreeMm, evals (may be +inf), rho
//   per component: double width, height, x, y; int32 rotation, side, twoSided, rotatable, small, key0, key1
//   per pin: int32 comp; double x, y
//   per net: int32 count, sig; double weight; int32 pins[count]
//   per pad: int32 comp, net, throughOrHole; double lx, ly, hx, hy   (hx, hy: half extents at rotation 0)
//   per decap: int32 comp, pad, hasMax; double maxMm; int32 icCount; int32 icPads[icCount]
//   int32 critCount; per critical constraint: int32 netCount, isPair, hasMaxLen, hasMaxMismatch;
//     double hw, maxLengthMm, maxMismatchMm; int32 nets[netCount]
// Output (stdout, JSON): {"evals", "accepted", "costDelta", "seconds", "layout": [[x, y, rotation], ...]}
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cmath>
#include <vector>
#include <chrono>
#include <algorithm>

using std::vector;
static FILE* in;
template <class T> T rd() { T x; if (fread(&x, sizeof(T), 1, in) != 1) { fprintf(stderr, "short input\n"); exit(2); } return x; }

struct Comp { double w, h, x, y; int rot, side, twoSided, rotatable, small, key[2]; };
struct Pin { int comp; double x, y; };
struct Pad { int comp, net, tho; double lx, ly, hx, hy; };
struct Decap { int comp, pad, hasMax; double maxMm; vector<int> ic; };
struct Crit { int pair, hasLen, hasMis; double hw, maxLen, maxMis; vector<int> nets; };

int main(int argc, char** argv) {
  const auto t0 = std::chrono::steady_clock::now();
  auto elapsed = [&]() { return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count(); };
  if (argc < 2 || !(in = fopen(argv[1], "rb"))) { fprintf(stderr, "usage: detail input.bin\n"); return 2; }
  const int n = rd<int32_t>(), netCount = rd<int32_t>(), pinCount = rd<int32_t>(), padCount = rd<int32_t>(), decapCount = rd<int32_t>();
  uint32_t s = (uint32_t)rd<int32_t>();
  const double W = rd<double>(), H = rd<double>(), clearance = rd<double>(), nu = rd<double>(), T0 = rd<double>(), relocate = rd<double>(), budgetS = rd<double>(), gap = rd<double>(), kappa = rd<double>(), decapFreeMm = rd<double>(), evals = rd<double>(), rho = rd<double>();
  vector<Comp> C(n);
  for (auto& c : C) { c.w = rd<double>(); c.h = rd<double>(); c.x = rd<double>(); c.y = rd<double>(); c.rot = rd<int32_t>(); c.side = rd<int32_t>(); c.twoSided = rd<int32_t>(); c.rotatable = rd<int32_t>(); c.small = rd<int32_t>(); c.key[0] = rd<int32_t>(); c.key[1] = rd<int32_t>(); }
  vector<Pin> P(pinCount);
  for (auto& q : P) { q.comp = rd<int32_t>(); q.x = rd<double>(); q.y = rd<double>(); }
  vector<vector<int>> netPins(netCount); vector<int> sig(netCount); vector<double> wN(netCount);
  for (int k = 0; k < netCount; k++) { const int c = rd<int32_t>(); sig[k] = rd<int32_t>(); wN[k] = rd<double>(); netPins[k].resize(c); for (auto& v : netPins[k]) v = rd<int32_t>(); }
  vector<Pad> RP(padCount);
  for (auto& q : RP) { q.comp = rd<int32_t>(); q.net = rd<int32_t>(); q.tho = rd<int32_t>(); q.lx = rd<double>(); q.ly = rd<double>(); q.hx = rd<double>(); q.hy = rd<double>(); }
  vector<Decap> D(decapCount);
  for (auto& d : D) { d.comp = rd<int32_t>(); d.pad = rd<int32_t>(); d.hasMax = rd<int32_t>(); d.maxMm = rd<double>(); const int c = rd<int32_t>(); d.ic.resize(c); for (auto& v : d.ic) v = rd<int32_t>(); }
  vector<Crit> CR(rd<int32_t>());
  for (auto& c : CR) { const int m = rd<int32_t>(); c.pair = rd<int32_t>(); c.hasLen = rd<int32_t>(); c.hasMis = rd<int32_t>(); c.hw = rd<double>(); c.maxLen = rd<double>(); c.maxMis = rd<double>(); c.nets.resize(m); for (auto& v : c.nets) v = rd<int32_t>(); }
  fclose(in);
  const double readS = elapsed();

  // Random stream of detail.mjs: s = imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0; s / 2^32.
  auto rnd = [&]() { s = (uint32_t)((s ^ (s >> 15)) * 2246822519u + 0x9e3779b9u); return s / 4294967296.0; };
  auto pick = [&](int len) { return (int)std::floor(rnd() * len); };

  vector<int> small; for (int i = 0; i < n; i++) if (C[i].small) small.push_back(i);
  auto out = [&](long tried, long acc, double delta) {
    printf("{\"evals\":%ld,\"accepted\":%ld,\"costDelta\":%.0f,\"seconds\":%.1f,\"readSeconds\":%.3f,\"searchSeconds\":%.3f,\"layout\":[", tried, acc, std::round(delta), std::round(elapsed() * 10) / 10, readS, elapsed() - readS);
    for (int i = 0; i < n; i++) printf(i ? ",[%.17g,%.17g,%d]" : "[%.17g,%.17g,%d]", C[i].x, C[i].y, C[i].rot);
    printf("]}\n");
  };
  if (small.empty()) { out(0, 0, 0); return 0; }

  // Bodies and the bucket grid (4 mm cells; JS: buckets, where, mark, stamp).
  auto boxOf = [&](int i, double b[4]) { const Comp& c = C[i]; const double w = (c.rot & 1) ? c.h : c.w, h = (c.rot & 1) ? c.w : c.h; b[0] = c.x - w / 2; b[1] = c.y - h / 2; b[2] = c.x + w / 2; b[3] = c.y + h / 2; };
  const double G = 4; const int gw = (int)std::ceil(W / G) + 1, gh = (int)std::ceil(H / G) + 1;
  vector<vector<int>> buckets(gw * gh), where(n); vector<int> mark(n, 0); int stamp = 0;
  auto clampi = [](int v, int lo, int hi) { return std::max(lo, std::min(hi, v)); };
  auto cellRange = [&](const double a[4], int r[4]) { r[0] = clampi((int)std::floor(a[0] / G), 0, gw - 1); r[1] = clampi((int)std::floor(a[1] / G), 0, gh - 1); r[2] = clampi((int)std::floor(a[2] / G), 0, gw - 1); r[3] = clampi((int)std::floor(a[3] / G), 0, gh - 1); };
  auto insert = [&](int i) { double b[4]; int r[4]; boxOf(i, b); cellRange(b, r); where[i].clear(); for (int y = r[1]; y <= r[3]; y++) for (int x = r[0]; x <= r[2]; x++) { buckets[y * gw + x].push_back(i); where[i].push_back(y * gw + x); } };
  auto remove = [&](int i) { for (int c : where[i]) { auto& bk = buckets[c]; size_t k = std::find(bk.begin(), bk.end(), i) - bk.begin(); bk[k] = bk.back(); bk.pop_back(); } };
  for (int i = 0; i < n; i++) insert(i);
  auto shares = [&](int i, int j) { return C[i].twoSided || C[j].twoSided || C[i].side == C[j].side; };
  auto legalAt = [&](int i, int skip) {
    double a[4]; boxOf(i, a); if (a[0] < 0 || a[1] < 0 || a[2] > W || a[3] > H) return false;
    const double q[4] = { a[0] - clearance, a[1] - clearance, a[2] + clearance, a[3] + clearance }; int r[4]; cellRange(q, r); stamp++; bool ok = true;
    for (int y = r[1]; y <= r[3] && ok; y++) for (int x = r[0]; x <= r[2] && ok; x++) for (int j : buckets[y * gw + x]) {
      if (mark[j] == stamp) continue; mark[j] = stamp;
      if (!ok || j == i || j == skip || !shares(i, j)) continue;
      double c[4]; boxOf(j, c); if (a[0] < c[2] + clearance && c[0] < a[2] + clearance && a[1] < c[3] + clearance && c[1] < a[3] + clearance) { ok = false; break; }
    }
    return ok;
  };

  // Pins, HPWL (JS worldPin: localPin then rotateQuarter).
  auto rq = [](double x, double y, int r, double& ox, double& oy) { switch (r & 3) { case 0: ox = x; oy = y; break; case 1: ox = -y; oy = x; break; case 2: ox = -x; oy = -y; break; default: ox = y; oy = -x; } };
  auto worldPin = [&](int pi, double& wx, double& wy) { const Pin& q = P[pi]; const Comp& c = C[q.comp]; double rx, ry; rq(c.side ? -q.x : q.x, q.y, c.rot, rx, ry); wx = c.x + rx; wy = c.y + ry; };
  vector<vector<int>> netsOf(n);
  for (int k = 0; k < netCount; k++) for (int pi : netPins[k]) { auto& v = netsOf[P[pi].comp]; if (std::find(v.begin(), v.end(), k) == v.end()) v.push_back(k); }
  auto hp = [&](int k) { const auto& ps = netPins[k]; if (ps.size() < 2) return 0.0; double x0 = INFINITY, y0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY;
    for (int pi : ps) { double x, y; worldPin(pi, x, y); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 - x0 + y1 - y0; };
  vector<double> hpN(netCount); for (int k = 0; k < netCount; k++) hpN[k] = hp(k);

  // Pads (geometry.mjs padCentre / padBox).
  vector<vector<int>> padsOf(n); for (int k = 0; k < padCount; k++) padsOf[RP[k].comp].push_back(k);
  auto centre = [&](int pi, double& x, double& y) { const Pad& q = RP[pi]; const Comp& c = C[q.comp]; double rx, ry; rq(c.side ? -q.lx : q.lx, q.ly, c.rot, rx, ry); x = c.x + rx; y = c.y + ry; };
  struct Box { double b[4]; int layers; };
  auto padBox = [&](int pi) { const Pad& q = RP[pi]; const Comp& c = C[q.comp]; double x, y; centre(pi, x, y); double hx = q.hx, hy = q.hy; if (c.rot & 1) std::swap(hx, hy);
    return Box{ { x - hx, y - hy, x + hx, y + hy }, q.tho ? 3 : c.side == 1 ? 2 : 1 }; };
  auto pairPen = [&](int pi, const Box& a, int pj, const Box& c) {
    if (RP[pi].comp == RP[pj].comp || (RP[pi].net >= 0 && RP[pi].net == RP[pj].net) || !(a.layers & c.layers)) return 0.0;
    const double ox = std::min(a.b[2], c.b[2]) - std::max(a.b[0], c.b[0]), oy = std::min(a.b[3], c.b[3]) - std::max(a.b[1], c.b[1]);
    const double g = ox > 0 && oy <= 0 ? -oy : oy > 0 && ox <= 0 ? -ox : ox > 0 && oy > 0 ? 0 : INFINITY; return g < gap ? gap - g : 0.0; };
  // Cache of pad boxes of parts that are not in the current move (invalidated when a part moves).
  vector<Box> boxCache(padCount); vector<char> boxValid(padCount, 0);
  auto cachedBox = [&](int pk) { if (!boxValid[pk]) { boxCache[pk] = padBox(pk); boxValid[pk] = 1; } return boxCache[pk]; };
  auto invalidate = [&](int i) { for (int pk : padsOf[i]) boxValid[pk] = 0; };
  // Pad overhang beyond the part body (rotation and side invariant): a neighbour whose body is farther
  // than gap + both overhangs cannot face a pad of the moved part within gap, so its pairs add only 0.
  vector<double> over(n, 0.0);
  for (const Pad& q : RP) { const Comp& c = C[q.comp];
    over[q.comp] = std::max({ over[q.comp], q.lx + q.hx - c.w / 2, -(q.lx - q.hx) - c.w / 2, q.ly + q.hy - c.h / 2, -(q.ly - q.hy) - c.h / 2 }); }
  vector<int> near; vector<int> mine; vector<Box> mb;
  auto chanOf = [&](const int* parts, int np) {
    mine.clear(); mb.clear(); for (int t = 0; t < np; t++) for (int pk : padsOf[parts[t]]) mine.push_back(pk);
    for (int pk : mine) mb.push_back(padBox(pk));
    const double r = gap + 2; double sum = 0; near.clear(); for (int t = 0; t < np; t++) near.push_back(parts[t]);
    stamp++; for (int t = 0; t < np; t++) mark[parts[t]] = stamp;
    for (int t = 0; t < np; t++) { double a[4]; boxOf(parts[t], a); const double q[4] = { a[0] - r, a[1] - r, a[2] + r, a[3] + r }; int cr[4]; cellRange(q, cr);
      for (int y = cr[1]; y <= cr[3]; y++) for (int x = cr[0]; x <= cr[2]; x++) for (int j : buckets[y * gw + x]) if (mark[j] != stamp) { mark[j] = stamp; near.push_back(j); } }
    double pb[2][4]; for (int t = 0; t < np; t++) boxOf(parts[t], pb[t]);
    for (int j : near) { if (padsOf[j].empty()) continue; const bool inS = j == parts[0] || (np > 1 && j == parts[1]);
      if (!inS) { double cbx[4]; boxOf(j, cbx); bool far = true;
        for (int t = 0; t < np && far; t++) { const double lim = gap + over[parts[t]] + over[j] + 1e-9, dx = std::max({ 0.0, cbx[0] - pb[t][2], pb[t][0] - cbx[2] }), dy = std::max({ 0.0, cbx[1] - pb[t][3], pb[t][1] - cbx[3] }); if (dx <= lim && dy <= lim) far = false; }
        if (far) continue; }
      for (int pj : padsOf[j]) { const Box cb = inS ? padBox(pj) : cachedBox(pj); for (size_t k = 0; k < mine.size(); k++) { if (inS && pj <= mine[k]) continue; sum += pairPen(mine[k], mb[k], pj, cb); } } }
    return sum; };

  // Decoupling capacitors.
  vector<int> decapOwn(n, -1); for (int k = 0; k < decapCount; k++) decapOwn[D[k].comp] = k;
  vector<vector<int>> decapsBy(n);
  for (int k = 0; k < decapCount; k++) { decapsBy[D[k].comp].push_back(k); vector<int> seen; for (int q : D[k].ic) { const int c = RP[q].comp; if (std::find(seen.begin(), seen.end(), c) == seen.end()) { seen.push_back(c); decapsBy[c].push_back(k); } } }
  auto decapDist = [&](int k) { const Decap& d = D[k]; double x, y; centre(d.pad, x, y); double best = INFINITY;
    for (int q : d.ic) { double u, v; centre(q, u, v); const double e = std::sqrt((u - x) * (u - x) + (v - y) * (v - y)); if (e < best) best = e; }
    return std::max(0.0, best - decapFreeMm) + (d.hasMax ? 10 * std::max(0.0, best - d.maxMm) : 0); };
  vector<int> ks;
  auto decapOf = [&](const int* parts, int np) { if (!kappa) return 0.0; ks.clear();
    for (int t = 0; t < np; t++) for (int k : decapsBy[parts[t]]) if (std::find(ks.begin(), ks.end(), k) == ks.end()) ks.push_back(k);
    double sum = 0; for (int k : ks) sum += decapDist(k); return sum; };


  // Critical nets with limits (JS critCost / critTouched; ks in insertion order).
  const int nc = (int)CR.size();
  vector<vector<int>> critOfComp(n);
  for (int k = 0; k < nc; k++) for (int ni : CR[k].nets) for (int pi : netPins[ni]) { auto& v = critOfComp[P[pi].comp]; if (std::find(v.begin(), v.end(), k) == v.end()) v.push_back(k); }
  vector<int> netLayers(netCount, 0); if (nc) for (int pk = 0; pk < padCount; pk++) if (RP[pk].net >= 0) netLayers[RP[pk].net] |= padBox(pk).layers;
  vector<double> px, py; vector<char> inT; vector<double> bestD; vector<int> bestU; vector<double> seg;
  // geometry.mjs spanningSegments (Prim from the first pin; distances with sqrt like detail.mjs).
  auto segsOf = [&](int ni) { const auto& ps = netPins[ni]; const int m = (int)ps.size(); px.resize(m); py.resize(m); seg.clear();
    for (int k = 0; k < m; k++) worldPin(ps[k], px[k], py[k]); if (!m) return;
    inT.assign(m, 0); bestD.resize(m); bestU.assign(m, 0); for (int k = 0; k < m; k++) bestD[k] = std::sqrt((px[k] - px[0]) * (px[k] - px[0]) + (py[k] - py[0]) * (py[k] - py[0])); inT[0] = 1;
    for (int it = 1; it < m; it++) { int u = -1; for (int k = 0; k < m; k++) if (!inT[k] && (u < 0 || bestD[k] < bestD[u])) u = k;
      inT[u] = 1; const int a = bestU[u]; seg.insert(seg.end(), { px[a], py[a], px[u], py[u] });
      for (int k = 0; k < m; k++) if (!inT[k]) { const double d = std::sqrt((px[k] - px[u]) * (px[k] - px[u]) + (py[k] - py[u]) * (py[k] - py[u])); if (d < bestD[k]) { bestD[k] = d; bestU[k] = u; } } } };
  auto segDist = [](double x, double y, const double* g) { const double dx = g[2] - g[0], dy = g[3] - g[1], l2 = dx * dx + dy * dy, u = l2 ? std::max(0.0, std::min(1.0, ((x - g[0]) * dx + (y - g[1]) * dy) / l2)) : 0;
    const double ex = g[0] + u * dx - x, ey = g[1] + u * dy - y; return std::sqrt(ex * ex + ey * ey); };
  auto critCost = [&](int k) { const Crit& c = CR[k]; double s = 0;
    for (int ni : c.nets) { const int lm = netLayers[ni]; segsOf(ni); const vector<double> sg = seg;
      for (size_t t = 0; t < sg.size(); t += 4) { const double* g = &sg[t];
        const double q[4] = { std::min(g[0], g[2]) - c.hw - 1, std::min(g[1], g[3]) - c.hw - 1, std::max(g[0], g[2]) + c.hw + 1, std::max(g[1], g[3]) + c.hw + 1 }; int cr[4]; cellRange(q, cr); stamp++;
        for (int y = cr[1]; y <= cr[3]; y++) for (int x = cr[0]; x <= cr[2]; x++) for (int j : buckets[y * gw + x]) { if (mark[j] == stamp) continue; mark[j] = stamp;
          for (int pj : padsOf[j]) { if (RP[pj].net == ni) continue; const Box bx = padBox(pj); if (!(bx.layers & lm)) continue; const double r = std::max(bx.b[2] - bx.b[0], bx.b[3] - bx.b[1]) / 2;
            if (segDist((bx.b[0] + bx.b[2]) / 2, (bx.b[1] + bx.b[3]) / 2, g) < c.hw + r) s += rho; } } }
      if (c.hasLen) s += 10 * std::max(0.0, hp(ni) - c.maxLen); }
    if (c.pair && c.hasMis) s += std::max(0.0, std::abs(hp(c.nets[0]) - hp(c.nets[1])) - c.maxMis);
    return s; };
  auto critBox = [&](int k, double o[4]) { const Crit& c = CR[k]; double x0 = INFINITY, y0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY;
    for (int ni : c.nets) for (int pi : netPins[ni]) { double x, y; worldPin(pi, x, y); x0 = std::min(x0, x); x1 = std::max(x1, x); y0 = std::min(y0, y); y1 = std::max(y1, y); }
    o[0] = x0 - c.hw - 1; o[1] = y0 - c.hw - 1; o[2] = x1 + c.hw + 1; o[3] = y1 + c.hw + 1; };
  vector<int> cks;
  auto critTouched = [&](const int* parts, int np) { for (int t = 0; t < np; t++) { const int i = parts[t];
      for (int k : critOfComp[i]) if (std::find(cks.begin(), cks.end(), k) == cks.end()) cks.push_back(k);
      double a[4]; boxOf(i, a); for (int k = 0; k < nc; k++) { if (std::find(cks.begin(), cks.end(), k) != cks.end()) continue; double c[4]; critBox(k, c); if (a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3]) cks.push_back(k); } } };
  auto critOf = [&]() { double s = 0; for (int k : cks) s += critCost(k); return s; };

  auto partnerMean = [&](int i, double& mx, double& my) { double sx = 0, sy = 0; int k = 0;
    for (int ni : netsOf[i]) { if (!sig[ni]) continue; for (int pi : netPins[ni]) { if (P[pi].comp == i) continue; double x, y; worldPin(pi, x, y); sx += x; sy += y; k++; } }
    if (!k) return false; mx = sx / k; my = sy / k; return true; };
  auto key = [&](int i, int rot) { return C[i].key[rot & 1]; };

  static const double steps[4] = { 0.4, 0.8, 1.2, 2 }; static const int dirs[4][2] = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
  // DETAIL_PROFILE=1: seconds per section on stderr.
  const bool prof = getenv("DETAIL_PROFILE") != nullptr; double tm[6] = { 0 }; auto tick = [&]() { return prof ? elapsed() : 0.0; };
  long tried = 0, accepted = 0; double delta = 0; vector<int> A; vector<double> oldH; vector<int> others;
  while (tried < evals && elapsed() < budgetS) {
    const int i = small[pick((int)small.size())]; const Comp old = C[i]; const double kind = rnd(); int j = -1; Comp oldJ{};
    if (kind < relocate) {
      const int own = decapOwn[i]; double mx, my;
      if (own >= 0) { const int q = D[own].ic[pick((int)D[own].ic.size())]; centre(q, mx, my); }
      else if (!partnerMean(i, mx, my)) continue;
      const double ux = (rnd() * 2 - 1) * 1.5; C[i].x = mx + ux; const double uy = (rnd() * 2 - 1) * 1.5; C[i].y = my + uy;
    } else if (kind < relocate + (1 - relocate) * 0.55) {
      const double st = steps[pick(4)]; const int* dr = dirs[pick(4)]; C[i].x = old.x + dr[0] * st; C[i].y = old.y + dr[1] * st;
    } else if (kind < relocate + (1 - relocate) * 0.8) {
      if (!C[i].rotatable) continue; C[i].rot = (old.rot + 1 + pick(3)) % 4;
    } else {
      const int sz = key(i, old.rot); others.clear();
      for (int k : small) { if (k == i || C[k].side != old.side) continue; const double dx = C[k].x - old.x, dy = C[k].y - old.y;
        if (!(std::abs(dx) < 6 && std::abs(dy) < 6 && std::sqrt(dx * dx + dy * dy) < 6)) continue; if (key(k, C[k].rot) == sz || key(k, C[k].rot + 1) == sz) others.push_back(k); }
      if (others.empty()) continue; j = others[pick((int)others.size())]; oldJ = C[j];
      const int rj = key(j, oldJ.rot) == sz ? oldJ.rot : (oldJ.rot + 1) % 4, ri = sz == key(j, oldJ.rot) ? old.rot : (old.rot + 1) % 4;
      C[i].x = oldJ.x; C[i].y = oldJ.y; C[i].rot = ri; C[j].x = old.x; C[j].y = old.y; C[j].rot = rj;
    }
    double ta = tick();
    const bool legal = legalAt(i, j) && (j < 0 || legalAt(j, i)); tm[0] += tick() - ta;
    if (!legal) { C[i] = old; if (j >= 0) C[j] = oldJ; continue; }
    tried++;
    const int parts[2] = { i, j }; const int np = j >= 0 ? 2 : 1; const Comp nwI = C[i], nwJ = j >= 0 ? C[j] : Comp{};
    C[i] = old; if (j >= 0) C[j] = oldJ;
    ta = tick(); const double g0 = nu ? chanOf(parts, np) : 0;
    C[i] = nwI; if (j >= 0) C[j] = nwJ;
    const double g1 = nu ? chanOf(parts, np) : 0; tm[1] += tick() - ta; ta = tick(); const double c1 = decapOf(parts, np); cks.clear(); if (nc) critTouched(parts, np);
    C[i] = old; if (j >= 0) C[j] = oldJ; const double c0 = decapOf(parts, np); if (nc) critTouched(parts, np); const double k0 = cks.empty() ? 0 : critOf();
    C[i] = nwI; if (j >= 0) C[j] = nwJ; const double k1 = cks.empty() ? 0 : critOf(); tm[2] += tick() - ta; ta = tick();
    A.clear(); for (int t = 0; t < np; t++) for (int k : netsOf[parts[t]]) if (std::find(A.begin(), A.end(), k) == A.end()) A.push_back(k);
    oldH.clear(); for (int k : A) oldH.push_back(hpN[k]);
    double dh = 0; for (int k : A) { const double v = hp(k); dh += (v - hpN[k]) * wN[k]; hpN[k] = v; }
    tm[3] += tick() - ta;
    const double d = dh + nu * (g1 - g0) + kappa * (c1 - c0) + (k1 - k0);
    const double T = T0 ? T0 * std::pow(1e-3, std::min(1.0, std::max(std::isfinite(evals) ? tried / evals : 0.0, elapsed() / budgetS))) : 0;
    if (d < -1e-6 || (T > 0 && rnd() < std::exp(-d / T))) { accepted++; delta += d; for (int t = 0; t < np; t++) { remove(parts[t]); insert(parts[t]); invalidate(parts[t]); } }
    else { for (size_t t = 0; t < A.size(); t++) hpN[A[t]] = oldH[t]; C[i] = old; if (j >= 0) C[j] = oldJ; }
  }
  if (prof) fprintf(stderr, "{\"legal\":%.3f,\"channel\":%.3f,\"decapCrit\":%.3f,\"hpwl\":%.3f,\"total\":%.3f}\n", tm[0], tm[1], tm[2], tm[3], elapsed());
  out(tried, accepted, delta);
  return 0;
}
