/**
 * SEEA Precision — 로컬 개발 서버
 * 실행: node server.mjs
 * 의존성: 없음 (Node.js 18+ 내장 모듈만 사용)
 */

import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { searchBib, getCompInfo, getGamePageHtml, getCompList, getEventRankings } from './bib-scraper.mjs';
import { startWatcher } from './watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3000;

// ── 업로드 디렉토리 ──────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── 커뮤니티 메시지 저장 ─────────────────────────────────
const COMMUNITY_FILE      = path.join(__dirname, 'community.json');
const COMMUNITY_SEED_FILE = path.join(__dirname, 'community-seed.json');
const communitySSE        = new Map(); // compId → Set<res>

// KSF 종목명 표기 통일 (쎈타화이어권총 → 센터파이어, 스탠다드권총 → 스탠다드 등)
function normalizeEventLabel(label) {
  return (label || '')
    .replace(/[쎈센쏀][터타][화파이]이?어(?:\s*권총)?/g, '센터파이어')
    .replace(/스[탠텐](?:다|더)드(?:\s*권총)?/g, '스탠다드');
}

function loadCommunity() {
  // 1) 런타임 파일 우선
  try { if (fs.existsSync(COMMUNITY_FILE)) return JSON.parse(fs.readFileSync(COMMUNITY_FILE, 'utf8')); }
  catch {}
  // 2) 런타임 파일 없으면 seed 로드 → 곧바로 community.json으로 저장
  try {
    if (fs.existsSync(COMMUNITY_SEED_FILE)) {
      const seed = JSON.parse(fs.readFileSync(COMMUNITY_SEED_FILE, 'utf8'));
      fs.writeFileSync(COMMUNITY_FILE, JSON.stringify(seed), 'utf8');
      console.log(`[COMM] community.json 없음 → seed(${seed.messages?.length ?? 0}건)에서 복원`);
      return seed;
    }
  } catch {}
  return { messages: [] };
}
function saveCommunity(data) {
  fs.writeFileSync(COMMUNITY_FILE, JSON.stringify(data), 'utf8');
}
function broadcastCommunity(compId, event, payload) {
  const clients = communitySSE.get(compId);
  if (!clients) return;
  const chunk = `event:${event}\ndata:${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(chunk); } catch {} }
}

// 대회별 전체 선수 캐시 (메모리 + 디스크 퍼시스턴스)
const BIB_CACHE_FILE = path.join(__dirname, 'bib-cache.json');
const compPlayersCache = new Map(); // compCode → { players: [], ts: number }

// 서버 시작 시 디스크 캐시 복원 (재배포 후에도 즉시 응답 가능)
// TTL 만료 여부와 무관하게 전부 복원한다 — KSF 장애 시 만료된 캐시라도
// stale 폴백으로 응답할 수 있어야 하기 때문. 신선도는 요청 시점에 판단.
try {
  if (fs.existsSync(BIB_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(BIB_CACHE_FILE, 'utf8'));
    let loaded = 0, stale = 0;
    const TTL  = 12 * 60 * 60 * 1000;
    for (const [comp, entry] of Object.entries(saved)) {
      if (!entry || !Array.isArray(entry.players)) continue;
      compPlayersCache.set(comp, entry);
      loaded++;
      if (Date.now() - entry.ts >= TTL) stale++;
    }
    if (loaded) console.log(`[CACHE] 디스크 캐시 복원 — ${loaded}개 대회${stale ? ` (만료 ${stale}개, KSF 장애 대비 보존)` : ''}`);
  }
} catch (e) { console.log('[CACHE] 디스크 캐시 로드 실패:', e.message); }

function saveBibCacheToDisk() {
  try {
    const obj = {};
    for (const [k, v] of compPlayersCache) obj[k] = v;
    fs.writeFileSync(BIB_CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch {}
}

// 대회 목록 캐시 (30분)
let compListCache = null; // { data: [], ts: number }
// 순위 캐시 — 신선 기준 5분, 그 이후엔 stale-while-revalidate (즉시 응답 + 백그라운드 갱신)
const rankingsCache = new Map(); // url → { data, ts }
const RANK_FRESH    = 5 * 60 * 1000;
const RANK_FILE     = path.join(__dirname, 'rankings-cache.json');
const _rankRefreshing = new Set(); // 중복 백그라운드 갱신 방지

// 서버 시작 시 순위 디스크 캐시 복원 (재배포·KSF 장애에도 결과 즉시 응답)
try {
  if (fs.existsSync(RANK_FILE)) {
    const saved = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
    let n = 0;
    for (const [url, entry] of Object.entries(saved)) {
      if (entry && entry.data) { rankingsCache.set(url, entry); n++; }
    }
    if (n) console.log(`[CACHE] 순위 캐시 복원 — ${n}건 (KSF 장애 대비 보존)`);
  }
} catch (e) { console.log('[CACHE] 순위 캐시 로드 실패:', e.message); }

let _rankSaveTimer = null;
function saveRankingsToDisk() {
  if (_rankSaveTimer) return;             // 디바운스 — 3초 내 변경 묶어서 1회 저장
  _rankSaveTimer = setTimeout(() => {
    _rankSaveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of rankingsCache) obj[k] = v;
      fs.writeFileSync(RANK_FILE, JSON.stringify(obj), 'utf8');
    } catch {}
  }, 3000);
}

async function _fetchRankings(url) {
  const data = await getEventRankings(url);
  rankingsCache.set(url, { data, ts: Date.now() });
  saveRankingsToDisk();
  return data;
}

// stale-while-revalidate: 캐시가 있으면 오래됐어도 즉시 반환하고,
// 5분 지났으면 백그라운드에서 조용히 갱신한다. 캐시가 없을 때만 라이브 대기(최초 1회).
async function getRankingsSWR(url) {
  const c = rankingsCache.get(url);
  if (c) {
    if (Date.now() - c.ts >= RANK_FRESH && !_rankRefreshing.has(url)) {
      _rankRefreshing.add(url);
      _fetchRankings(url).catch(() => {}).finally(() => _rankRefreshing.delete(url));
    }
    return c.data;
  }
  return _fetchRankings(url);
}

// 대회 종목 이벤트 캐시 (1시간)
const compEventsCache = new Map(); // compCode → { events: [], ts: number }
// 팀 메달 집계 캐시 (5분)
const teamMedalsCache = new Map(); // `${comp}:${affLower}` → { data, ts }

// ── 동명이인 생년 DB 로드 ─────────────────────────────────
function loadPlayerBirths() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'player-births.json'), 'utf8');
    const data = JSON.parse(raw);
    const map = new Map();
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      map.set(key, Array.isArray(val) ? val : [val]);
    }
    return map;
  } catch { return new Map(); }
}
let playerBirthsDB = loadPlayerBirths();
// 파일 변경 감지 (서버 재시작 없이 반영)
fs.watch(path.join(__dirname, 'player-births.json'), () => {
  playerBirthsDB = loadPlayerBirths();
  console.log('[births] player-births.json 재로드');
});

// 선수 데이터에 생년 주입
function injectBirthYears(players) {
  // 이름+소속 기준으로 중복 선수 파악
  const nameAffCount = new Map();
  for (const p of players) {
    const k = `${p.name}|${p.affiliation}`;
    nameAffCount.set(k, (nameAffCount.get(k) || 0) + 1);
  }
  // 중복인 선수에게만 생년 추가
  const nameAffIdx = new Map(); // 같은 이름+소속 내 순서 추적
  return players.map(p => {
    const k = `${p.name}|${p.affiliation}`;
    if (p.teamType === '단체') return p;
    if ((nameAffCount.get(k) || 0) <= 1) return p;
    if (p.birthYear) return p;                    // 스크래퍼 파싱 생년 유지
    const births = playerBirthsDB.get(k);
    if (!births) return p;                        // DB 없어도 기존 데이터 유지
    const idx = nameAffIdx.get(k) || 0;
    nameAffIdx.set(k, idx + 1);
    return { ...p, birthYear: births[idx] || '' };
  });
}

// ── 대회 전체 선수 데이터 확보 (stale-on-error 폴백) ─────────
// 신선한 캐시가 있으면 즉시 반환. 만료/없으면 KSF 재조회.
// KSF가 먹통이라 재조회가 실패하면 만료된 캐시라도 그대로 반환한다(stale=true).
// 캐시도 없고 조회도 실패한 경우에만 { players:null, error } 반환.
async function getCompPlayers(comp, { maxAge = 12 * 60 * 60 * 1000 } = {}) {
  const cached = compPlayersCache.get(comp);
  if (cached && Date.now() - cached.ts < maxAge) {
    return { players: cached.players, ts: cached.ts, stale: false };
  }
  const ageH = c => Math.round((Date.now() - c.ts) / 3600000);
  try {
    const result = await searchBib(comp, '', 'name'); // searchName 무관하게 전체 선수 반환
    if (result.ok && result.allPlayers?.length) {
      const entry = { players: result.allPlayers, ts: Date.now() };
      compPlayersCache.set(comp, entry);
      saveBibCacheToDisk();
      return { players: entry.players, ts: entry.ts, stale: false };
    }
    // KSF 응답은 받았지만 비어있음 → 만료 캐시 폴백
    if (cached) {
      console.warn(`[CACHE] ${comp} KSF 빈 응답 → 만료 캐시 폴백 (${cached.players.length}명, ${ageH(cached)}h 경과)`);
      return { players: cached.players, ts: cached.ts, stale: true };
    }
    return { players: null, error: result.error || 'KSF 데이터를 불러올 수 없습니다.' };
  } catch (err) {
    // KSF 장애(타임아웃·5xx 등) → 만료 캐시 폴백
    if (cached) {
      console.warn(`[CACHE] ${comp} KSF 조회 실패(${err.message}) → 만료 캐시 폴백 (${cached.players.length}명, ${ageH(cached)}h 경과)`);
      return { players: cached.players, ts: cached.ts, stale: true };
    }
    return { players: null, error: err.message };
  }
}

// ── .env 파일 로드 ────────────────────────────────────────
function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env 없어도 무시 */ }
}
loadEnv();

// ── ISSF 규정 AI 시스템 프롬프트 ─────────────────────────
const SYSTEM_PROMPT = `당신은 SEEA Precision AI입니다. 한국 사격 선수·코치·심판을 위한 ISSF 규정 전문 어시스턴트입니다.

[핵심 규칙]
1. 항상 한국어로 답변하세요.
2. 첨부된 ISSF 공식 규정집을 최우선 참조하세요.
3. 규정 조항 번호를 반드시 인용하세요 (예: GTR 6.15.1, TR 6.4.1.2).
4. 규정집에서 확인되지 않는 내용은 "규정집에서 확인되지 않습니다. 원문을 직접 확인하세요"라고 명시하세요.
5. 모든 답변 끝에 반드시 추가: "⚠️ 참고용 답변입니다. 공식 원문 확인 필수."
6. ISSF 규정 외 질문(기술, 훈련, 장비 구매 등)은 "ISSF 규정 관련 질문을 해주세요."로 안내하세요.
7. 답변은 2~4문장 이내로 간결하게. 핵심 → 맥락 순서로. 불필요한 반복·부연 생략.

[종목 확인 규칙]
8. 질문에 종목이 명시되지 않으면 해당 분류의 종목 목록을 번호로 제시하고 선택을 요청하세요. 모든 종목을 한꺼번에 답변하지 마세요.
9. 아래 키워드가 있으면 종목 확인 없이 즉시 답변하세요:
   공기소총/AR/10m소총 → 10m 공기소총 | 공기권총/AP/10m권총 → 10m 공기권총
   3자세/3P → 50m 소총 3자세 | 복사/PR → 50m 소총 복사
   25m권총/RF/래피드파이어 → 25m 권총 | 스포츠권총/SP → 25m 스포츠 권총
   트랩/Trap → 트랩 | 더블트랩 → 더블 트랩 | 스키트/Skeet → 스키트

[한국 용어 규칙]
10. "본선" = ISSF "Qualification". 사용자가 "본선"이라고 하면 Qualification 규정으로 답변하세요.
    사용자 질문에 "본선"이 직접 포함된 경우에만, 딱 한 번: "※ 한국의 '본선'은 ISSF 공식 용어로 'Qualification(예선)'입니다. '결선(Final)'은 상위 선수들의 별도 경기입니다."
11. "결선" = ISSF "Final". 답변에서 "예선"이라는 표현 대신 "본선(Qualification)"을 사용하세요.

[동점 처리 — 반드시 우선 적용]
12. 소수점 채점 종목(10m 공기소총, 50m 소총 복사) 동점: GTR 6.15.1 f 적용.
    순서: ① 마지막 10발 시리즈 소수점 비교 → ② 마지막 발부터 한 발씩 소수점 비교.
    ❌ 이너 텐(X-ten) 개수는 이 종목의 동점 기준이 아님 (정수 채점 종목에만 적용).
13. 정수 채점 종목(10m 공기권총, 25m 권총, 25m 스포츠 권총) 동점: GTR 6.15.1 a~e 적용.
    순서: ① X-ten 개수 → ② 마지막 시리즈부터 역순 정수 비교 → ③ 마지막 발부터 X-ten 비교 → ④ EST 소수점 비교 → ⑤ 공동 순위(알파벳순).

[초과 발사 규정 — 반드시 두 조항을 함께 적용]
14. 선수가 종목 또는 자세에서 규정된 발수보다 많이 발사한 경우 (Rule 6.11.5):
    ① 초과 발은 마지막 표적에서 무효 처리 (식별 불가 시 최고점 발 무효)
    ② **추가로 초과 발 1발당 2점 감점** — 첫 번째 시리즈 최저점에서 차감
    ❌ "최저점 발 제외만" 또는 "감점 없음"으로 답변하는 것은 오답임. 두 조항이 동시에 적용됨.`;

// ── 규정집 업로드 (Gemini Files API) ──────────────────────
let rulesFileUri   = null;
let rulesUploading = false;

const RULES_FILENAME = 'Eng_ISSF_rules_2026.01.01.md';

async function uploadRulesPDF() {
  if (!process.env.GEMINI_API_KEY) return;

  const rulesDir = path.join(__dirname, 'rules');
  let pdfPath = null;
  try {
    const filePath = path.join(rulesDir, RULES_FILENAME);
    if (fs.existsSync(filePath)) pdfPath = filePath;
  } catch { /* 폴더 없으면 무시 */ }

  if (!pdfPath) {
    console.log(`    📄 규정집 없음 — rules/${RULES_FILENAME} 파일을 넣으면 자동 학습됩니다`);
    return;
  }

  rulesUploading = true;
  const fileName = path.basename(pdfPath);
  const fileSize = fs.statSync(pdfPath).size;
  const sizeMB   = (fileSize / 1024 / 1024).toFixed(1);
  console.log(`    📤 규정집 업로드 중: ${fileName} (${sizeMB} MB) ...`);

  try {
    const pdfData = fs.readFileSync(pdfPath);

    if (fileSize < 15 * 1024 * 1024) {
      // ── 15 MB 미만: multipart upload ──────────────────
      const boundary = 'GeminiBoundary' + Date.now();
      const metadata = JSON.stringify({ file: { display_name: 'ISSF Rules 2026' } });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(metadata),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`),
        pdfData,
        Buffer.from(`\r\n--${boundary}--`),
      ]);

      const res = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
        {
          method:  'POST',
          headers: {
            'Content-Type':           `multipart/related; boundary=${boundary}`,
            'X-Goog-Upload-Protocol': 'multipart',
          },
          body,
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Upload HTTP ${res.status}`);
      }
      const data = await res.json();
      rulesFileUri = data.file?.uri;

    } else {
      // ── 15 MB 이상: resumable upload ──────────────────
      // Step 1: 업로드 세션 초기화
      const initRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
        {
          method:  'POST',
          headers: {
            'Content-Type':                        'application/json',
            'X-Goog-Upload-Protocol':              'resumable',
            'X-Goog-Upload-Command':               'start',
            'X-Goog-Upload-Header-Content-Length': String(fileSize),
            'X-Goog-Upload-Header-Content-Type':   'text/plain; charset=utf-8',
          },
          body: JSON.stringify({ file: { display_name: 'ISSF Rules 2026' } }),
        }
      );
      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `Init HTTP ${initRes.status}`);
      }
      const uploadUrl = initRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) throw new Error('업로드 URL을 받지 못했습니다');

      // Step 2: 파일 본문 전송
      const uploadRes = await fetch(uploadUrl, {
        method:  'POST',
        headers: {
          'Content-Length':        String(fileSize),
          'X-Goog-Upload-Offset':  '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: pdfData,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error?.message || `Upload HTTP ${uploadRes.status}`);
      }
      const data = await uploadRes.json();
      rulesFileUri = data.file?.uri;
    }

    if (!rulesFileUri) throw new Error('URI를 받지 못했습니다');
    console.log(`    ✅ 규정집 업로드 완료 (${sizeMB} MB) — AI가 2026 전체 규정집으로 답변합니다`);
  } catch (e) {
    console.log(`    ❌ 규정집 업로드 실패: ${e.message}`);
  } finally {
    rulesUploading = false;
  }
}

// ── MIME 타입 ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

// ── 방문자 통계 (일자별 고유 deviceId, KST 기준) ───────────
const VISITS_FILE = path.join(__dirname, 'visits.json');
const visitDays   = new Map(); // 'YYYY-MM-DD' → Set<deviceId>
const visitAllIds = new Set(); // 전체 기간 고유 방문자
try {
  if (fs.existsSync(VISITS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    for (const [day, ids] of Object.entries(saved.days || {})) visitDays.set(day, new Set(ids));
    (saved.allIds || []).forEach(id => visitAllIds.add(id));
    console.log(`[VISIT] 방문자 통계 복원 — 누적 ${visitAllIds.size}명`);
  }
} catch (e) { console.log('[VISIT] 통계 로드 실패:', e.message); }

const kstDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

let _visitSaveTimer = null;
function saveVisits() {
  if (_visitSaveTimer) return;          // 디바운스 — 5초 내 변경 묶어서 1회 저장
  _visitSaveTimer = setTimeout(() => {
    _visitSaveTimer = null;
    try {
      const days = {};
      for (const [day, set] of visitDays) days[day] = [...set];
      fs.writeFileSync(VISITS_FILE, JSON.stringify({ days, allIds: [...visitAllIds] }), 'utf8');
    } catch {}
  }, 5000);
}
function pruneVisitDays() {            // 최근 60일만 보관
  const keep = new Set();
  for (let i = 0; i < 60; i++) keep.add(kstDate(-i));
  for (const day of visitDays.keys()) if (!keep.has(day)) visitDays.delete(day);
}

// Supabase 영구 저장 — 재배포(디스크 초기화)에도 누적 유지
const _sbV = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_ANON_KEY,
  get headers() { return { 'Content-Type':'application/json', 'apikey': this.key||'', 'Authorization':`Bearer ${this.key||''}` }; },
  get on() { return !!(this.url && this.key); },
};
async function loadVisitsFromSupabase() {
  if (!_sbV.on) return;
  try {
    const since = kstDate(-59);
    const [vdRes, vRes] = await Promise.all([
      fetch(`${_sbV.url}/rest/v1/visit_days?day=gte.${since}&select=day,device_id&limit=200000`, { headers: _sbV.headers }),
      fetch(`${_sbV.url}/rest/v1/visitors?select=device_id&limit=2000000`, { headers: _sbV.headers }),
    ]);
    if (vdRes.ok) for (const r of await vdRes.json()) {
      if (!visitDays.has(r.day)) visitDays.set(r.day, new Set());
      visitDays.get(r.day).add(r.device_id);
    }
    if (vRes.ok) for (const r of await vRes.json()) visitAllIds.add(r.device_id);
    console.log(`[VISIT] Supabase 복원 — 누적 ${visitAllIds.size}명`);
  } catch (e) { console.log('[VISIT] Supabase 복원 실패:', e.message); }
}
function pushVisitToSupabase(day, id) { // 중복은 PK 충돌로 무시됨 (fire-and-forget)
  if (!_sbV.on) return;
  const opt = { method:'POST', headers:{ ..._sbV.headers, 'Prefer':'resolution=ignore-duplicates,return=minimal' } };
  fetch(`${_sbV.url}/rest/v1/visit_days`, { ...opt, body: JSON.stringify({ day, device_id: id }) }).catch(()=>{});
  fetch(`${_sbV.url}/rest/v1/visitors`,   { ...opt, body: JSON.stringify({ device_id: id }) }).catch(()=>{});
}
loadVisitsFromSupabase();

// ── HTTP 서버 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/chat ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!process.env.GEMINI_API_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not configured' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body);
        if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 필드가 비어 있습니다.');

        // 규정집 파일을 첫 번째 user 메시지에 합쳐서 turn 구조 유지
        const geminiMessages = [];

        if (rulesFileUri) {
          const [first, ...rest] = messages;
          geminiMessages.push({
            role: 'user',
            parts: [
              { fileData: { mimeType: 'text/plain', fileUri: rulesFileUri } },
              { text: first.content },
            ],
          });
          for (const m of rest) {
            geminiMessages.push({
              role:  m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            });
          }
        } else {
          for (const m of messages) {
            geminiMessages.push({
              role:  m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            });
          }
        }

        const apiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: geminiMessages,
              generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
            }),
          }
        );

        if (!apiRes.ok) {
          const err = await apiRes.json().catch(() => ({}));
          throw new Error(err.error?.message || `Gemini API ${apiRes.status}`);
        }

        const data    = await apiRes.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '답변을 생성하지 못했습니다.';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content, hasRules: !!rulesFileUri }));

      } catch (err) {
        console.error('[/api/chat]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /api/bib-debug?comp=N01H&sex=2&bb=5&i1=11 ──────
  // 인코딩·구조 진단용: td 목록 + 파싱 시뮬레이션 결과 반환
  if (req.method === 'GET' && req.url.startsWith('/api/bib-debug')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || 'N01H').trim();
    const sex    = params.get('sex')  || '2';
    const bb     = params.get('bb')   || '5';
    const i1     = params.get('i1')   || '11';

    try {
      const targetUrl = `https://www.shooting.or.kr/score/score_2015_player.asp?jname=${comp}&sex=${sex}&bb=${bb}&i1=${i1}`;
      const r   = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Referer':    'https://www.shooting.or.kr',
          'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        }
      });
      const buf = await r.arrayBuffer();
      const ct  = r.headers.get('content-type') || '';

      // EUC-KR 디코딩
      let html = '';
      try { html = new TextDecoder('euc-kr', { fatal: false }).decode(buf); }
      catch { html = new TextDecoder('utf-8', { fatal: false }).decode(buf); }

      // td 내용 전체 추출
      const stripTags = s => (s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
      const allTds = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
      const BIB_RE = /^\d{1,3}\s*[-–]\s*\d{1,4}$/; // "2-72" or "2 - 72"
      const bibTds = allTds.filter(t => BIB_RE.test(t));

      // 처음 60개 td와 전체 HTML 앞부분
      const lines = [
        `── 진단 URL ─────────────────────────────────────`,
        `URL: ${targetUrl}`,
        `Content-Type 헤더: ${ct}`,
        `버퍼 크기: ${buf.byteLength} bytes`,
        ``,
        `── TD 통계 ──────────────────────────────────────`,
        `전체 <td> 수: ${allTds.length}`,
        `사대번호 패턴 셀 수: ${bibTds.length}`,
        bibTds.length > 0 ? `사대번호 샘플: ${bibTds.slice(0,10).join(', ')}` : '→ 사대번호 셀 없음 (배정표 미게시 or 구조 다름)',
        ``,
        `── 첫 100개 TD 내용 ─────────────────────────────`,
        ...allTds.slice(0, 100).map((t, i) => `[${i}] ${t || '(empty)'}`),
        ``,
        `── HTML 앞 2000자 (EUC-KR 디코딩) ───────────────`,
        html.slice(0, 2000),
      ];

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines.join('\n'));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('오류: ' + e.message + '\n' + e.stack);
    }
    return;
  }

  // ── GET /api/game-debug?comp=N01H ───────────────────────
  // 게임 페이지 원본 HTML + 파싱된 이벤트 목록 확인
  if (req.method === 'GET' && req.url.startsWith('/api/game-debug')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || 'N01H').trim();
    try {
      const { html, events } = await getGamePageHtml(comp);
      // 전체 HTML에서 날짜 패턴 검색
      const allDates = [...html.matchAll(
        /(\d{4}년?\s*\d{1,2}월\s*\d{1,2}일)|(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})|(\d{1,2}월\s*\d{1,2}일)/g
      )].map(m => m[0].replace(/\s+/g,''));
      const uniqueDates = [...new Set(allDates)];

      // 전체 HTML에서 시간 패턴 검색
      const allTimes = [...html.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);
      const uniqueTimes = [...new Set(allTimes)];

      // 위치 정보 포함 날짜 수집
      const DATE_FULL = /(\d{4}년?\s*\d{1,2}월\s*\d{1,2}일)|(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})|(\d{1,2}월\s*\d{1,2}일)/g;
      const datePositions = [...html.matchAll(DATE_FULL)].map(m => ({ pos: m.index, text: m[0] }));
      // 위치 정보 포함 URL 수집
      const URL_FULL = /["']([^"']*score_2015_player\.asp\?[^"']+)["']/g;
      const urlPositions = [...html.matchAll(URL_FULL)].map(m => ({ pos: m.index, url: m[1] }));

      const firstUrlPos = urlPositions[0]?.pos ?? -1;
      const lastUrlPos  = urlPositions[urlPositions.length - 1]?.pos ?? -1;

      const lines = [
        `── 게임 페이지 파싱 결과 ───────────────────────────`,
        `URL: https://www.shooting.or.kr/score/score_2015_game.asp?jname=${comp}`,
        `이벤트 수: ${events.length}`,
        `HTML 총 길이: ${html.length}자`,
        ``,
        `── 날짜/시간 패턴 (전체 HTML) ───────────────────────`,
        `날짜 발견: ${uniqueDates.length}개 → ${uniqueDates.join(', ') || '없음'}`,
        `시간 발견: ${uniqueTimes.length}개 → ${uniqueTimes.join(', ') || '없음'}`,
        ``,
        `── 위치 분석 (날짜 vs URL) ──────────────────────────`,
        `첫 번째 URL 위치: ${firstUrlPos}`,
        `마지막 URL 위치: ${lastUrlPos}`,
        `날짜 위치들:`,
        ...datePositions.map(d => `  pos=${d.pos} (URL 대비 ${d.pos - firstUrlPos > 0 ? '+' : ''}${d.pos - firstUrlPos}) → ${d.text}`),
        ``,
        `── 이벤트 목록 ──────────────────────────────────────`,
        ...events.map((e, i) => {
          const sched = [e.scheduleDate, e.scheduleTime].filter(Boolean).join(' ');
          return `[${i}] ${e.eventLabel}` + (sched ? ` | ${sched}` : '') + `\n     → ${e.playerUrl}`;
        }),
        ``,
        `── 게임 페이지 HTML 앞 3000자 ───────────────────────`,
        html.slice(0, 3000),
      ];
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(lines.join('\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('오류: ' + e.message);
    }
    return;
  }

  // ── GET /api/bib-warm?comp=N01H ─────────────────────────
  // 대회 선택 시 미리 캐시 워밍 (검색 전 백그라운드 로딩)
  if (req.method === 'GET' && req.url.startsWith('/api/bib-warm')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    const cached = compPlayersCache.get(comp);
    const isWarm = cached && Date.now() - cached.ts < 12 * 60 * 60 * 1000;
    const hasStale = !!(cached && cached.players?.length);
    if (!isWarm) {
      // 즉시 응답하고 백그라운드에서 데이터 로딩 (실패 시 만료 캐시 유지)
      getCompPlayers(comp)
        .then(g => { if (g.players && !g.stale) console.log(`[WARM] ${comp} 캐시 완료 — ${g.players.length}명`); })
        .catch(e => console.log(`[WARM] ${comp} 캐시 실패: ${e.message}`));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ cached: isWarm, hasStale }));
    return;
  }

  // ── GET /api/player-results?comp=N01H&name=홍길동 ────────
  if (req.method === 'GET' && req.url.startsWith('/api/player-results')) {
    const params      = new URL(req.url, 'http://localhost').searchParams;
    const comp        = (params.get('comp') || '').trim();
    const name        = decodeURIComponent(params.get('name') || '').trim();
    const birthYear   = (params.get('birthYear') || '').trim();
    const affiliation = decodeURIComponent(params.get('affiliation') || '').trim();

    if (!comp || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp와 name이 필요합니다.' }));
      return;
    }

    const cached = compPlayersCache.get(comp);
    if (!cached) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '대회 데이터가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.' }));
      return;
    }

    const playerEvents = cached.players.filter(p => {
      if (p.name !== name || !p.personUrl) return false;
      // 생년 필터
      if (birthYear && p.birthYear && p.birthYear !== birthYear) return false;
      // 소속 필터
      if (affiliation && p.affiliation && p.affiliation !== affiliation) return false;
      return true;
    });
    if (!playerEvents.length) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '해당 선수의 경기 정보를 찾을 수 없습니다.' }));
      return;
    }

    // personUrl 기준 중복 제거
    const seen = new Set();
    const uniqueEvents = playerEvents.filter(p => {
      if (seen.has(p.personUrl)) return false;
      seen.add(p.personUrl);
      return true;
    });

    const POSITION_LABELS = ['슬사','복사','입사','서서','무릎','엎드려',
                             '8s','6s','4s','8초','6초','4초',
                             '완사','급사','150s','20s','10s'];

    // 자세 소계 추출: 총점 바로 앞 숫자값, 없으면 행 내 최대값
    const getPosSubtotal = (row, totalStr) => {
      const isS = v => v && /^\d{2,}[\d.]*$/.test((v||'').trim());
      const totalNum = parseFloat(totalStr);
      const ti = row.indexOf(totalStr);
      if (ti >= 0) {
        for (let i = ti - 1; i >= 3; i--) {
          const v = (row[i] || '').trim();
          if (isS(v) && parseFloat(v) < totalNum) return v;
        }
        return '';
      }
      let maxV = 0, maxStr = '';
      for (let i = 3; i < row.length; i++) {
        const v = (row[i] || '').trim();
        if (isS(v) && parseFloat(v) > maxV) { maxV = parseFloat(v); maxStr = v; }
      }
      return maxStr;
    };

    // KSF 행 파싱: colspan 때문에 헤더 인덱스 불일치 → 최대값=본선합계, 그 뒤=기록/결선
    const parsePlayerResult = row => {
      const RECORDS = ['대회신','한국신','세계신','아시아신','주니어신','학생신'];
      const isRec   = v => RECORDS.some(w => (v||'').includes(w));
      const isEmpty = v => !v || ['-','.',''].includes((v||'').trim());
      const isScore      = v => v && /^\d{2,}[\d.]*(-\d+x?)?$/.test(v);
      const isFinalScore = v => v && /^\d+[\d.]*(-\d+x?)?$/.test(v);

      // 최대값 = 본선합계
      let score = '', scoreIdx = -1, bestNum = 0;
      for (let i = 3; i < row.length; i++) {
        const v = row[i];
        if (isScore(v)) {
          const n = parseFloat(v);
          if (n > bestNum) { bestNum = n; score = v; scoreIdx = i; }
        }
      }
      if (!score) return { score:'', record:'', final:'', finalRecord:'' };

      // 본선합계 직후 기록 표시 탐색
      let record = '';
      for (let i = scoreIdx + 1; i < row.length; i++) {
        const v = row[i];
        if (isRec(v)) { record = v; break; }
        if (!isEmpty(v)) break;
      }

      // 결선 점수 탐색 (본선합계보다 작은 다음 숫자 — 1자리 포함)
      let final = '', finalIdx = -1;
      for (let i = scoreIdx + 1; i < row.length; i++) {
        const v = row[i];
        if (isFinalScore(v) && parseFloat(v) < bestNum) { final = v; finalIdx = i; break; }
      }

      // 결선 직후 기록 표시 탐색
      let finalRecord = '';
      for (let i = finalIdx + 1; finalIdx >= 0 && i < row.length; i++) {
        const v = row[i];
        if (isRec(v)) { finalRecord = v; break; }
        if (!isEmpty(v)) break;
      }

      return { score, record, final, finalRecord };
    };

    try {
      const results = await Promise.all(uniqueEvents.map(async p => {
        try {
          const data = await getRankingsSWR(p.personUrl);

          const { rows = [], headers = [] } = data;
          if (!rows.length) return { event: p.event, rank: '', score: '', record: '', final: '', finalRecord: '', total: 0, date: p.scheduleDate, affiliation: p.affiliation };

          // 실제 선수 수: 이름(row[2]) 기준 중복 제거 (3자세 Format B 포맷 대응)
          const mainRowsRaw = rows.filter(r => /^\d+$/.test((r[0]||'').trim()));
          const playerByName = new Map();
          for (const r of mainRowsRaw) {
            const n = (r[2] || '').trim();
            if (!n) continue;
            const p2 = parsePlayerResult(r);
            const s  = parseFloat(p2.score) || 0;
            if (!playerByName.has(n) || s > playerByName.get(n).score) {
              playerByName.set(n, { row: r, score: s });
            }
          }
          const playerCount = playerByName.size || mainRowsRaw.length;

          // 대상 선수 행: 이름 포함 행 중 점수 최대 행 선택 — 소속 필터로 동명이인 구분
          const targetAff = (p.affiliation || '').trim();
          let playerRow = null, parsed = {};
          for (const r of rows) {
            if (!(r[2] || '').includes(name)) continue;
            if (targetAff && (r[1] || '').trim() && !(r[1] || '').includes(targetAff)) continue;
            const p2 = parsePlayerResult(r);
            const s  = parseFloat(p2.score) || 0;
            if (s > (parseFloat(parsed.score) || 0)) { playerRow = r; parsed = p2; }
          }

          // 본선등위: 모든 메인 행을 점수 기준 정렬 후 playerRow의 순위 산출
          let qualRank = '';
          if (parsed.score && playerRow && mainRowsRaw.length > 0) {
            const allScored = mainRowsRaw.map(r => ({
              row: r,
              score: parseFloat(parsePlayerResult(r).score) || 0,
            })).sort((a, b) => b.score - a.score);
            const qi = allScored.findIndex(q => q.row === playerRow);
            if (qi >= 0) qualRank = String(qi + 1);
          }

          // 3자세/속사권총/25m권총 등 자세별 sub-row 파싱 (Format A/B 모두 지원)
          const positions = [];
          if (playerRow && POSITION_LABELS.includes(playerRow[3])) {
            const playerMainIdx = rows.indexOf(playerRow);
            const namedPosRows  = rows.filter(r =>
              (r[2] || '').includes(name) && POSITION_LABELS.includes(r[3]));
            if (namedPosRows.length > 1) {
              // 동명이인 혼재 방지: playerRow와 같은 등위 행만 사용
              const playerRank   = (playerRow[0] || '').trim();
              const sameRankRows = namedPosRows.filter(r => (r[0] || '').trim() === playerRank);
              const posRows      = sameRankRows.length > 0 ? sameRankRows : namedPosRows;
              for (const pr of posRows) {
                positions.push({ pos: pr[3], score: getPosSubtotal(pr, parsed.score) });
              }
            } else {
              positions.push({ pos: playerRow[3], score: getPosSubtotal(playerRow, parsed.score) });
              for (let si = playerMainIdx + 1; si < rows.length; si++) {
                const sr = rows[si];
                if (!POSITION_LABELS.includes(sr[0])) break;
                positions.push({ pos: sr[0], score: getPosSubtotal(sr, parsed.score) });
              }
            }
          }

          // 헤더 기반 자세 폴백 (속사 권총 등 단일행 포맷 — 선수당 1행, 자세명이 th에만 있는 경우)
          if (positions.length === 0 && headers.length > 0 && playerRow) {
            headers.forEach((h, hi) => {
              if (!POSITION_LABELS.includes(h.trim())) return;
              const val = (playerRow[hi] || '').trim();
              if (val && /^\d{2,}[\d.]*$/.test(val) && parseFloat(val) < parseFloat(parsed.score)) {
                positions.push({ pos: h.trim(), score: val });
              }
            });
          }

          // 속사 권총 전반/후반 형식: 전반/후반 행을 합산하여 8s/6s/4s 계산
          if (positions.length === 0 && playerRow && ['전반', '후반'].includes(playerRow[3])) {
            const mainOffset    = 4;
            const totalIdx      = playerRow.indexOf(parsed.score);
            if (totalIdx > mainOffset + 1) {
              const numStages      = totalIdx - 1 - mainOffset;
              const playerMainIdx  = rows.indexOf(playerRow);
              const rounds         = [{ row: playerRow, offset: mainOffset }];
              for (let si = playerMainIdx + 1; si < rows.length; si++) {
                const sr  = rows[si];
                const sr0 = (sr[0] || '').trim();
                if (!['전반', '후반'].includes(sr0)) break;
                rounds.push({ row: sr, offset: 1 });
              }
              const defaultLabels = { 3: ['8s','6s','4s'], 2: ['완사','급사'] };
              const stageLabels   = defaultLabels[numStages] || Array.from({ length: numStages }, (_, i) => `${i+1}`);
              for (let si = 0; si < numStages; si++) {
                let tot = 0;
                for (const { row: rr, offset } of rounds) {
                  tot += parseFloat(rr[offset + si] || '') || 0;
                }
                if (tot > 0) positions.push({ pos: stageLabels[si], score: String(Math.round(tot * 10) / 10) });
              }
            }
          }

          // 정수 경기 소수점 .0 제거 (10m 공기소총·50m 복사 외)
          const isDecimalEvent = /10m.*공기소총|50m.*복사/.test(p.event || '');
          const stripDotZero   = s => s && !isDecimalEvent ? s.replace(/\.0(-|$)/, '$1') : s;

          return {
            event:       p.event,
            rank:        playerRow ? (playerRow[0] || '') : '',
            qualRank,
            score:       stripDotZero(parsed.score       || ''),
            record:      parsed.record      || '',
            final:       parsed.final       || '',   // 결선은 항상 소수점 유지
            finalRecord: parsed.finalRecord || '',
            positions:   positions.map(pos => ({ ...pos, score: stripDotZero(pos.score) })),
            total:       playerCount || rows.length,
            date:        p.scheduleDate,
            affiliation: p.affiliation,
          };
        } catch (e) {
          return { event: p.event, rank: '', score: '', total: 0, date: p.scheduleDate, affiliation: p.affiliation };
        }
      }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name, affiliation: uniqueEvents[0]?.affiliation || '', results }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/bib?comp=N01H&name=홍길동 ──────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/bib') &&
      !req.url.startsWith('/api/bib-debug') && !req.url.startsWith('/api/bib-adjacent') &&
      !req.url.startsWith('/api/bib-result') && !req.url.startsWith('/api/bib-warm')) {
    const params   = new URL(req.url, 'http://localhost').searchParams;
    const comp       = (params.get('comp') || '').trim();
    const name       = (params.get('name') || '').trim();
    const searchMode = (params.get('mode') || 'name').trim();

    if (!comp || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp(대회코드)와 name(이름)이 필요합니다.' }));
      return;
    }

    try {
      // 신선하면 캐시, 만료/없으면 KSF 재조회. KSF 장애 시 만료 캐시로 폴백.
      const got = await getCompPlayers(comp, { maxAge: 12 * 60 * 60 * 1000 });
      if (!got.players) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: got.error || 'KSF 데이터를 불러올 수 없습니다.' }));
        return;
      }
      const allPlayers = got.players;
      console.log(`[/api/bib] ${comp}, "${name}" (${allPlayers.length}명 중 검색)${got.stale ? ' [stale 폴백]' : ''}`);

      const searchLower = name.toLowerCase();
      const rawMatched = searchMode === 'team'
        ? allPlayers.filter(p => p.affiliation && p.affiliation.toLowerCase().includes(searchLower))
        : allPlayers.filter(p => p.name.includes(name));
      // 이름+소속 기준 동명이인에 생년 주입 (전체 대회 선수 기준으로 중복 판단)
      const matched = injectBirthYears(rawMatched);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, total: allPlayers.length, matched, searchMode, stale: got.stale, cachedAt: got.ts }));
    } catch (err) {
      console.error('[/api/bib]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/teams?comp=N01H ─────────────────────────────
  // 해당 대회에 출전한 팀 목록 반환 (캐시 우선)
  if (req.method === 'GET' && req.url.startsWith('/api/teams')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    const cached = compPlayersCache.get(comp);
    if (cached && cached.players?.length) {
      // 신선/만료 무관하게 캐시가 있으면 즉시 팀 목록 반환 (KSF 장애에도 동작)
      const teams = [...new Set(cached.players.map(p => p.affiliation).filter(Boolean))];
      const isStale = Date.now() - cached.ts >= 12 * 60 * 60 * 1000;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ teams, stale: isStale }));
      // 만료 캐시면 백그라운드에서 갱신 시도 (실패해도 기존 캐시 유지)
      if (isStale) getCompPlayers(comp).catch(() => {});
    } else {
      // 캐시 없으면 백그라운드에서 전체 선수 fetch 시작
      getCompPlayers(comp).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ teams: [], warming: true }));
    }
    return;
  }

  // ── GET /api/bib-result?comp=N01H&event=…&name=…&isTeam=0 ──
  if (req.method === 'GET' && req.url.startsWith('/api/bib-result')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp')  || '').trim();
    const event  = decodeURIComponent(params.get('event') || '').trim();
    const name   = decodeURIComponent(params.get('name')  || '').trim();
    const isTeam = params.get('isTeam') === '1';

    const cached = compPlayersCache.get(comp);
    if (!cached) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '대회 데이터가 없습니다. 사대번호 검색을 먼저 해주세요.' }));
      return;
    }

    const player = cached.players.find(p =>
      p.event === event && p.name === name
    );
    if (!player) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '결과 페이지 링크를 찾을 수 없습니다.' }));
      return;
    }

    let rankUrl = player.personUrl;
    if (!rankUrl) {
      // bib 캐시가 낡아 personUrl이 없을 때: comp-events에서 폴백 조회
      try {
        let events;
        const evtCached = compEventsCache.get(comp);
        if (evtCached && Date.now() - evtCached.ts < 60 * 60 * 1000) {
          events = evtCached.data.events;
        } else {
          const { events: rawEvts } = await getGamePageHtml(comp);
          const seen = new Set();
          events = [];
          for (const e of rawEvts) {
            const key = e.personUrl || `${e.eventLabel}|${e.scheduleDate}`;
            if (!seen.has(key)) { seen.add(key); events.push(e); }
          }
          compEventsCache.set(comp, { data: { comp, events }, ts: Date.now() });
        }
        const match = events.find(e => e.personUrl && e.eventLabel === event);
        if (match) rankUrl = match.personUrl;
      } catch { /* 폴백 실패 시 아래에서 에러 처리 */ }
    }
    if (!rankUrl) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '이 종목의 결과가 아직 게시되지 않았습니다.' }));
      return;
    }

    try {
      // 캐시 있으면 즉시(stale 포함), 없으면 라이브 1회. KSF 장애 시 캐시 폴백.
      const data = await getRankingsSWR(rankUrl);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[/api/bib-result]', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '결과 조회 실패: ' + err.message }));
    }
    return;
  }

  // ── GET /api/bib-adjacent?comp=N01H&event=…&group=2&lane=C ──
  if (req.method === 'GET' && req.url.startsWith('/api/bib-adjacent')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp')  || '').trim();
    const event  = (params.get('event') || '').trim();
    const group  = (params.get('group') || '').trim();
    const lane   = (params.get('lane')  || '').trim();
    if (!comp || !event || !group || !lane) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '파라미터가 부족합니다.' }));
      return;
    }
    try {
      // 앞뒤 사대는 비교적 최신성이 중요 → 2시간. 만료/장애 시 stale 폴백.
      const got = await getCompPlayers(comp, { maxAge: 2 * 60 * 60 * 1000 });
      if (!got.players) throw new Error(got.error || '데이터 없음');
      const players = got.players;
      // 속사(알파벳 사대)와 일반(숫자 사대) 모두 처리
      const isAlpha = /^[A-Za-z]+$/.test(lane);
      const groupPlayers = players
        .filter(p => p.event === event && p.group === group)
        .sort((a, b) => isAlpha
          ? a.lane.localeCompare(b.lane)
          : parseInt(a.lane) - parseInt(b.lane));
      const idx  = groupPlayers.findIndex(p => p.lane === lane);
      const prev = idx > 0 ? groupPlayers[idx - 1] : null;
      const next = idx !== -1 && idx < groupPlayers.length - 1 ? groupPlayers[idx + 1] : null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ prev, next }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/player-names?comp=N01H ─────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/player-names')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) { res.writeHead(400); res.end(JSON.stringify({ names: [] })); return; }
    const cached = compPlayersCache.get(comp);
    if (cached && cached.players?.length) {
      const names = [...new Set(cached.players.map(p => p.name).filter(Boolean))]
        .sort(() => Math.random() - 0.5).slice(0, 40);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ names }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ names: [], warming: true }));
    }
    return;
  }

  // ── GET /api/feed  |  POST /api/feed  |  DELETE /api/feed ──
  const ADMIN_PW  = process.env.ADMIN_PASSWORD || 'kimchi5841*';
  const SB_URL    = process.env.SUPABASE_URL;
  const SB_KEY    = process.env.SUPABASE_ANON_KEY;
  const sbHeaders = {
    'Content-Type':  'application/json',
    'apikey':        SB_KEY || '',
    'Authorization': `Bearer ${SB_KEY || ''}`,
  };

  if (req.url.startsWith('/api/feed')) {
    if (!SB_URL || !SB_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Supabase 미설정' }));
      return;
    }

    if (req.method === 'GET') {
      try {
        const sbRes = await fetch(`${SB_URL}/rest/v1/ideas?order=ts.desc&limit=60`, { headers: sbHeaders });
        const data  = await sbRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(Array.isArray(data) ? data : []));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { name, msg } = JSON.parse(body);
          const text = (msg || '').trim().slice(0, 120);
          if (!text) { res.writeHead(400); res.end(); return; }
          const sbRes = await fetch(`${SB_URL}/rest/v1/ideas`, {
            method:  'POST',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
            body:    JSON.stringify({
              name: (name || '익명').trim().slice(0, 20) || '익명',
              msg:  text,
              ts:   Date.now(),
            }),
          });
          if (!sbRes.ok) throw new Error(`Supabase ${sbRes.status}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    if (req.method === 'DELETE') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { ts: delTs, pw } = JSON.parse(body);
          if (pw !== ADMIN_PW) { res.writeHead(403); res.end(JSON.stringify({ error: '비밀번호가 틀렸습니다.' })); return; }
          const sbRes = await fetch(`${SB_URL}/rest/v1/ideas?ts=eq.${delTs}`, {
            method:  'DELETE',
            headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          });
          if (!sbRes.ok) throw new Error(`Supabase ${sbRes.status}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
  }

  // ── GET /api/visit?id=<deviceId> — 방문 기록 + 통계 반환 ──
  if (req.method === 'GET' && req.url.startsWith('/api/visit')) {
    const id = (new URL(req.url, 'http://localhost').searchParams.get('id') || '').toString().slice(0, 64);
    const today = kstDate(0), yest = kstDate(-1);
    if (id) {
      if (!visitDays.has(today)) visitDays.set(today, new Set());
      const set = visitDays.get(today);
      const changed = !set.has(id) || !visitAllIds.has(id);
      set.add(id); visitAllIds.add(id);
      if (changed) { pruneVisitDays(); saveVisits(); pushVisitToSupabase(today, id); }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      today:     visitDays.get(today)?.size || 0,
      yesterday: visitDays.get(yest)?.size  || 0,
      total:     visitAllIds.size,
    }));
    return;
  }

  // ── GET /api/comp-list ──────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/comp-list') {
    try {
      const now = Date.now();
      if (!compListCache || now - compListCache.ts > 30 * 60 * 1000) {
        try {
          compListCache = { data: await getCompList(), ts: now };
        } catch (fetchErr) {
          // KSF 장애 → 만료된 대회목록 캐시라도 있으면 폴백
          if (compListCache) {
            console.warn(`[/api/comp-list] 갱신 실패(${fetchErr.message}) → 만료 캐시 폴백`);
          } else {
            throw fetchErr;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(compListCache.data));
    } catch (err) {
      console.error('[/api/comp-list]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/cache-refresh?comp=N01H (bib 캐시 즉시 갱신) ─
  if (req.method === 'GET' && req.url.startsWith('/api/cache-refresh')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    // 즉시 재fetch — 성공할 때만 교체한다(KSF 장애 시 기존 캐시 보존)
    const prevPlayers = compPlayersCache.get(comp);
    try {
      const result = await searchBib(comp, '', 'name');
      if (result.ok && result.allPlayers?.length) {
        compPlayersCache.set(comp, { players: injectBirthYears(result.allPlayers), ts: Date.now() });
        saveBibCacheToDisk();
        // 갱신 성공 시에만 파생 캐시 무효화
        compEventsCache.delete(comp);
        for (const k of teamMedalsCache.keys()) {
          if (k.startsWith(comp + ':')) teamMedalsCache.delete(k);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, players: compPlayersCache.get(comp).players.length }));
      } else {
        // KSF 빈 응답 → 기존 캐시 유지하고 그 사실 통지
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: result.error || 'KSF 응답 없음', kept: prevPlayers?.players?.length ?? 0 }));
      }
    } catch (err) {
      // KSF 장애 → 기존 캐시 유지
      console.warn(`[/api/cache-refresh] ${comp} 갱신 실패(${err.message}) → 기존 캐시 유지`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message, kept: prevPlayers?.players?.length ?? 0 }));
    }
    return;
  }

  // ── GET /api/team-medals?comp=N01H&aff=서산시청 ──────────
  if (req.method === 'GET' && req.url.startsWith('/api/team-medals')) {
    const params   = new URL(req.url, 'http://localhost').searchParams;
    const comp     = (params.get('comp') || '').trim();
    const aff      = (params.get('aff')  || '').trim();
    if (!comp || !aff) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp, aff 파라미터가 필요합니다.' }));
      return;
    }
    try {
      const affLower  = aff.toLowerCase();
      const cacheKey  = `${comp}:${affLower}`;
      const cached    = teamMedalsCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cached.data));
        return;
      }

      // 종목 목록: 기존 compEventsCache 재사용, 없으면 새로 fetch
      let events;
      const evtCached = compEventsCache.get(comp);
      if (evtCached && Date.now() - evtCached.ts < 60 * 60 * 1000) {
        events = evtCached.data.events;
      } else {
        const { events: rawEvts } = await getGamePageHtml(comp);
        const seenPerson = new Set();
        events = [];
        for (const evt of rawEvts) {
          const key = evt.personUrl || `${evt.eventLabel}|${evt.scheduleDate}`;
          if (!seenPerson.has(key)) { seenPerson.add(key); events.push(evt); }
        }
        compEventsCache.set(comp, { data: { comp, events }, ts: Date.now() });
      }

      const personEvents = events.filter(e => e.personUrl);
      const groupEvents  = events.filter(e => e.groupUrl);

      const [personResults, groupResults] = await Promise.all([
        Promise.all(personEvents.map(async e => {
          try {
            const { rows = [] } = await getRankingsSWR(e.personUrl);
            const rankRows = rows.filter(r => /^\d+$/.test((r[0]||'').trim()));
            const medals = [];
            for (const row of rankRows) {
              if (!(row[1]||'').toLowerCase().includes(affLower)) continue;
              const rank = parseInt(row[0]);
              if (rank < 1 || rank > 3 || /기준점수/.test(row.slice(3).join(' '))) continue;
              medals.push({ rank, event: e.eventLabel, name: (row[2] || '').trim() });
            }
            return medals;
          } catch { return []; }
        })),
        Promise.all(groupEvents.map(async e => {
          try {
            const { rows = [] } = await getRankingsSWR(e.groupUrl);
            const rankRows = rows.filter(r => /^\d+$/.test((r[0]||'').trim()));
            const idx = rankRows.findIndex(r => (r[1]||'').toLowerCase().includes(affLower));
            if (idx < 0) return [];
            const rank = parseInt(rankRows[idx][0]);
            if (rank < 1 || rank > 3 || /기준점수/.test(rankRows[idx][4]||'')) return [];
            return [{ rank, event: e.eventLabel }];
          } catch { return []; }
        })),
      ]);

      const data = { indivMedals: personResults.flat(), teamMedals: groupResults.flat() };
      teamMedalsCache.set(cacheKey, { data, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[/api/team-medals]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/comp-events?comp=N01H ──────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/comp-events')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    try {
      const COMP_EVENTS_TTL = 60 * 60 * 1000; // 1시간 캐시
      const cached = compEventsCache.get(comp);
      if (cached && Date.now() - cached.ts < COMP_EVENTS_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cached.data));
        return;
      }

      const { html, events } = await getGamePageHtml(comp);
      const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title  = titleM ? titleM[1].trim() : comp;

      // personUrl로 중복 제거 (같은 종목의 여러 조를 하나로)
      const seenPerson = new Set();
      const unique = [];
      for (const evt of events) {
        const key = evt.personUrl || `${evt.eventLabel}|${evt.scheduleDate}`;
        if (!seenPerson.has(key)) {
          seenPerson.add(key);
          unique.push({
            eventLabel:   normalizeEventLabel(evt.eventLabel),
            personUrl:    evt.personUrl,
            groupUrl:     evt.groupUrl,
            scheduleDate: evt.scheduleDate,
            scheduleTime: evt.scheduleTime,
          });
        }
      }
      const payload = { comp, title, events: unique };
      compEventsCache.set(comp, { data: payload, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[/api/comp-events]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/event-rankings?url=...&type=person|group ───
  if (req.method === 'GET' && req.url.startsWith('/api/event-rankings')) {
    const params  = new URL(req.url, 'http://localhost').searchParams;
    const rankUrl = decodeURIComponent(params.get('url') || '').trim();
    if (!rankUrl.startsWith('https://www.shooting.or.kr/') &&
        !rankUrl.startsWith('http://www.shooting.or.kr/')) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '허용되지 않는 URL입니다.' }));
      return;
    }
    try {
      const data = await getRankingsSWR(rankUrl);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[/api/event-rankings]', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/comp-info?comp=N01H ────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/comp-info')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const comp   = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'comp 파라미터가 필요합니다.' }));
      return;
    }
    try {
      const info = await getCompInfo(comp);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/community/today-finale?comp=I02B ───────────
  // 오늘 날짜에 경기가 있는 결선 종목+종별 목록 반환
  if (req.method === 'GET' && req.url.startsWith('/api/community/today-finale')) {
    const params  = new URL(req.url, 'http://localhost').searchParams;
    const comp    = (params.get('comp') || '').trim();
    if (!comp) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'comp required' }));
      return;
    }
    try {
      let events;
      const cached = compEventsCache.get(comp);
      if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
        events = cached.data.events;
      } else {
        const { events: rawEvts } = await getGamePageHtml(comp);
        const seen = new Set();
        events = [];
        for (const e of rawEvts) {
          const key = e.playerUrl || `${e.eventLabel}|${e.scheduleDate}`;
          if (!seen.has(key)) { seen.add(key); events.push(e); }
        }
        compEventsCache.set(comp, { data: { comp, events }, ts: Date.now() });
      }
      const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
      const todayM = kstNow.getUTCMonth() + 1;
      const todayD = kstNow.getUTCDate();
      const parseDateStr = s => {
        const m = (s || '').match(/(\d{1,2})월\s*(\d{1,2})일/);
        return m ? { month: parseInt(m[1]), day: parseInt(m[2]) } : null;
      };
      const FINALE_PREFIXES = ['10m 공기소총','10m 공기권총','25m 속사권총','25m 권총','50m 3자세'];
      const parseLabel = label => {
        for (const prefix of FINALE_PREFIXES) {
          if ((label || '').startsWith(prefix))
            return { event: prefix, division: label.slice(prefix.length).trim() };
        }
        return null;
      };
      const isFinaleEligible = (event, division) => {
        if (event === '10m 공기권총' || event === '10m 공기소총') return !division.includes('초등부');
        if (event === '25m 권총')     return division.startsWith('여자');
        if (event === '25m 속사권총') return division.startsWith('남자');
        if (event === '50m 3자세')    return true;
        return false;
      };
      const seen2 = new Set();
      const result = [];
      for (const e of events) {
        const d = parseDateStr(e.scheduleDate);
        if (!d || d.month !== todayM || d.day !== todayD) continue;
        const parsed = parseLabel(e.eventLabel || '');
        if (!parsed) continue;
        const { event, division } = parsed;
        if (!isFinaleEligible(event, division)) continue;
        const key = `${event}|${division}`;
        if (seen2.has(key)) continue;
        seen2.add(key);
        result.push({ event, division });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ events: result }));
    } catch (err) {
      console.error('[today-finale]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/community/:compId/stream (SSE) ────────────
  const sseMatch = req.url.match(/^\/api\/community\/([^\/]+)\/stream$/);
  if (req.method === 'GET' && sseMatch) {
    const compId = sseMatch[1];
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive',
    });
    res.write(':\n\n'); // keep-alive comment
    if (!communitySSE.has(compId)) communitySSE.set(compId, new Set());
    communitySSE.get(compId).add(res);
    req.on('close', () => {
      communitySSE.get(compId)?.delete(res);
    });
    return;
  }

  // ── GET /api/community/:compId ──────────────────────────
  const _getMsgUrl   = new URL(req.url, 'http://localhost');
  const getMsgMatch  = _getMsgUrl.pathname.match(/^\/api\/community\/([^\/]+)$/);
  if (req.method === 'GET' && getMsgMatch) {
    const compId  = getMsgMatch[1];
    const deviceId = _getMsgUrl.searchParams.get('deviceId') || '';
    const { messages } = loadCommunity();
    const filtered = messages.filter(m => m.compId === compId).map(m => ({
      ...m,
      // 이 디바이스가 투표했는지 여부를 함께 반환
      _myAgree:    deviceId ? (m.agreeVoters   || []).includes(deviceId) : false,
      _myObo:      deviceId ? (m.oboVoters     || []).includes(deviceId) : false,
      _myDisagree: deviceId ? (m.disagreeVoters|| []).includes(deviceId) : false,
      // 5분 이내 본인 제보 여부 (취소 버튼 표시용)
      _myPost:     deviceId && m.authorDeviceId === deviceId && (Date.now() - m.ts) < 5 * 60 * 1000,
      // authorDeviceId는 클라이언트에 노출하지 않음
      authorDeviceId: undefined,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(filtered));
    return;
  }

  // ── POST /api/community/:compId ─────────────────────────
  const postMsgMatch = req.url.match(/^\/api\/community\/([^\/]+)$/);
  if (req.method === 'POST' && postMsgMatch) {
    const compId = postMsgMatch[1];
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { nickname, tag, text, event, division, imageData, deviceId: authorDeviceId } = JSON.parse(body);
        if (!nickname?.trim() || !text?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '닉네임과 내용을 입력하세요.' }));
          return;
        }
        const VALID_TAGS = ['공식훈련', '장비검사', '결선시간', '기타'];
        const safeTag = VALID_TAGS.includes(tag) ? tag : '기타';

        // 결선시간 중복 차단: 같은 compId + event + division은 1개만 허용
        // 오보 2개 이상 메시지는 신뢰도 상실로 중복 체크 대상에서 제외
        if (safeTag === '결선시간' && event) {
          const data = loadCommunity();
          const existing = data.messages.find(m =>
            m.compId === compId && m.tag === '결선시간' &&
            m.event === event.toString().trim() &&
            (m.division || '') === (division ? division.toString().trim() : '') &&
            (m.obo || 0) < 2
          );
          if (existing) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'duplicate', existing }));
            return;
          }
        }

        // 이미지 처리 (base64 → 파일 저장)
        let imageUrl = '';
        if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
          const m = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
          if (m) {
            const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
            const buf = Buffer.from(m[2], 'base64');
            const fname = `img_${Date.now()}_${Math.random().toString(36).slice(2,6)}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
            imageUrl = `/uploads/${fname}`;
          }
        }

        const msg = {
          id:       Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          compId,
          nickname: nickname.trim().slice(0, 20),
          tag:      safeTag,
          text:     text.trim().slice(0, 300),
          event:    (event || '').toString().trim().slice(0, 50),
          division: (division || '').toString().trim().slice(0, 20),
          imageUrl,
          ts:             Date.now(),
          agree:          0,
          disagree:       0,
          obo:            0,
          authorDeviceId: (authorDeviceId || '').toString().slice(0, 64),
        };
        const data = loadCommunity();
        data.messages.push(msg);
        // 대회당 최대 500개
        data.messages = data.messages.filter(m => m.compId !== compId).concat(
          data.messages.filter(m => m.compId === compId).slice(-500)
        );
        saveCommunity(data);
        broadcastCommunity(compId, 'message', msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '요청 파싱 오류' }));
      }
    });
    return;
  }

  // ── POST /api/community/msg/:msgId/agree (토글) ──────────
  const agreeMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/agree$/);
  if (req.method === 'POST' && agreeMatch) {
    const msgId = agreeMatch[1];
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let deviceId = '';
    try { deviceId = JSON.parse(body).deviceId || ''; } catch {}
    const data = loadCommunity();
    const msg  = data.messages.find(m => m.id === msgId);
    if (!msg) { res.writeHead(404); res.end('{}'); return; }
    if (!msg.agreeVoters) msg.agreeVoters = [];
    if (!msg.oboVoters)   msg.oboVoters   = [];
    // 오보 신고한 사람은 맞아요 불가
    if (deviceId && msg.oboVoters.includes(deviceId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '오보 신고한 제보입니다', agree: msg.agreeVoters.length, voted: false }));
      return;
    }
    if (deviceId) {
      const idx = msg.agreeVoters.indexOf(deviceId);
      if (idx !== -1) msg.agreeVoters.splice(idx, 1); // 철회
      else            msg.agreeVoters.push(deviceId);  // 투표
    }
    msg.agree = msg.agreeVoters.length;
    saveCommunity(data);
    const voted = deviceId ? msg.agreeVoters.includes(deviceId) : null;
    broadcastCommunity(msg.compId, 'agree', { id: msgId, agree: msg.agree });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agree: msg.agree, voted }));
    return;
  }

  // ── POST /api/community/msg/:msgId/disagree (토글) ────────
  const disagreeMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/disagree$/);
  if (req.method === 'POST' && disagreeMatch) {
    const msgId = disagreeMatch[1];
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let deviceId = '';
    try { deviceId = JSON.parse(body).deviceId || ''; } catch {}
    const data = loadCommunity();
    const msg  = data.messages.find(m => m.id === msgId);
    if (!msg) { res.writeHead(404); res.end('{}'); return; }
    if (!msg.disagreeVoters) msg.disagreeVoters = [];
    if (deviceId) {
      const idx = msg.disagreeVoters.indexOf(deviceId);
      if (idx !== -1) msg.disagreeVoters.splice(idx, 1);
      else            msg.disagreeVoters.push(deviceId);
    }
    msg.disagree = msg.disagreeVoters.length;
    saveCommunity(data);
    const voted = deviceId ? msg.disagreeVoters.includes(deviceId) : null;
    broadcastCommunity(msg.compId, 'disagree', { id: msgId, disagree: msg.disagree });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ disagree: msg.disagree, voted }));
    return;
  }

  // ── POST /api/community/msg/:msgId/like (bib 패널 호환) ──
  const likeMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/like$/);
  if (req.method === 'POST' && likeMatch) {
    const msgId = likeMatch[1];
    const data  = loadCommunity();
    const msg   = data.messages.find(m => m.id === msgId);
    if (!msg) { res.writeHead(404); res.end('{}'); return; }
    msg.likes = (msg.likes || 0) + 1;
    saveCommunity(data);
    broadcastCommunity(msg.compId, 'like', { id: msgId, likes: msg.likes });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ likes: msg.likes }));
    return;
  }

  // ── POST /api/community/msg/:msgId/obo (토글) ────────────
  const oboMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/obo$/);
  if (req.method === 'POST' && oboMatch) {
    const msgId = oboMatch[1];
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let deviceId = '';
    try { deviceId = JSON.parse(body).deviceId || ''; } catch {}
    const data = loadCommunity();
    const msg  = data.messages.find(m => m.id === msgId);
    if (!msg) { res.writeHead(404); res.end('{}'); return; }
    if (!msg.oboVoters)   msg.oboVoters   = [];
    if (!msg.agreeVoters) msg.agreeVoters = [];
    // 맞아요 누른 사람은 오보 불가
    if (deviceId && msg.agreeVoters.includes(deviceId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '맞아요한 제보입니다', obo: msg.oboVoters.length, voted: false }));
      return;
    }
    if (deviceId) {
      const idx = msg.oboVoters.indexOf(deviceId);
      if (idx !== -1) msg.oboVoters.splice(idx, 1); // 철회
      else            msg.oboVoters.push(deviceId);  // 신고
    }
    msg.obo = msg.oboVoters.length;
    const voted = deviceId ? msg.oboVoters.includes(deviceId) : null;

    // 오보 3개 달성 → 자동 삭제
    if (msg.obo >= 3) {
      const delIdx = data.messages.findIndex(m => m.id === msgId);
      if (delIdx !== -1) data.messages.splice(delIdx, 1);
      saveCommunity(data);
      if (msg.imageUrl) {
        const imgPath = path.join(__dirname, msg.imageUrl);
        if (fs.existsSync(imgPath)) try { fs.unlinkSync(imgPath); } catch {}
      }
      broadcastCommunity(msg.compId, 'delete', { id: msgId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ obo: msg.obo, voted, autoDeleted: true }));
      return;
    }

    saveCommunity(data);
    broadcastCommunity(msg.compId, 'obo', { id: msgId, obo: msg.obo });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ obo: msg.obo, voted }));
    return;
  }

  // ── POST /api/community/msg/:msgId/delete (관리자) ────────
  const delMsgMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/delete$/);
  if (req.method === 'POST' && delMsgMatch) {
    const msgId = delMsgMatch[1];
    let body = '';
    req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let pw = '';
    try { pw = JSON.parse(body).password || ''; } catch {}
    const COMM_ADMIN_PW = process.env.ADMIN_PASSWORD || 'kimchi5841*';
    if (pw !== COMM_ADMIN_PW) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '비밀번호가 틀렸습니다' }));
      return;
    }
    // probe 요청: 비밀번호 검증만 하고 실제 삭제 없이 반환
    let bodyParsed = {};
    try { bodyParsed = JSON.parse(body); } catch {}
    if (bodyParsed.probe || msgId === '__probe') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const data = loadCommunity();
    const idx  = data.messages.findIndex(m => m.id === msgId);
    if (idx === -1) { res.writeHead(404); res.end('{}'); return; }
    const [deleted] = data.messages.splice(idx, 1);
    saveCommunity(data);
    // 이미지 파일도 삭제
    if (deleted.imageUrl) {
      const imgPath = path.join(__dirname, deleted.imageUrl);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    broadcastCommunity(deleted.compId, 'delete', { id: msgId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /api/community/msg/:msgId/self-delete (본인 취소, 5분 이내) ──
  const selfDelMatch = req.url.match(/^\/api\/community\/msg\/([^\/]+)\/self-delete$/);
  if (req.method === 'POST' && selfDelMatch) {
    const msgId = selfDelMatch[1];
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    let deviceId = '';
    try { deviceId = JSON.parse(body).deviceId || ''; } catch {}
    const data = loadCommunity();
    const idx  = data.messages.findIndex(m => m.id === msgId);
    if (idx === -1) { res.writeHead(404); res.end('{}'); return; }
    const msg = data.messages[idx];
    if (!deviceId || msg.authorDeviceId !== deviceId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '권한 없음' }));
      return;
    }
    if (Date.now() - msg.ts > 5 * 60 * 1000) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '5분이 경과하여 취소할 수 없습니다' }));
      return;
    }
    const [deleted] = data.messages.splice(idx, 1);
    saveCommunity(data);
    if (deleted.imageUrl) {
      const imgPath = path.join(__dirname, deleted.imageUrl);
      if (fs.existsSync(imgPath)) try { fs.unlinkSync(imgPath); } catch {}
    }
    broadcastCommunity(deleted.compId, 'delete', { id: msgId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /uploads/:filename ───────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/uploads/')) {
    const fname    = path.basename(decodeURIComponent(req.url.slice('/uploads/'.length)));
    const fpath    = path.join(UPLOAD_DIR, fname);
    if (!fs.existsSync(fpath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext  = path.extname(fname).slice(1).toLowerCase();
    const mime = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(fpath).pipe(res);
    return;
  }

  // ── 정적 파일 서빙 ──────────────────────────────────────
  let urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const fullPath = path.join(__dirname, urlPath);

  if (!fullPath.startsWith(__dirname + path.sep) && fullPath !== __dirname) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const serveFile = (filePath, data, stat) => {
    const ext         = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const isHtml      = ext === '.html' || ext === '';
    // ETag = mtime 기반 (배포 시 파일 변경 → ETag 변경 → 브라우저 자동 갱신)
    const etag        = `"${stat.mtimeMs.toString(36)}"`;
    const cacheCtrl   = isHtml
      ? 'no-cache'                    // HTML: 항상 서버에 확인 (304 활용)
      : 'public, max-age=3600';       // 기타: 1시간 캐시

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheCtrl });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type':  contentType,
      'Cache-Control': cacheCtrl,
      'ETag':          etag,
    });
    res.end(data);
  };

  fs.stat(fullPath, (statErr, stat) => {
    if (statErr) {
      // 파일 없으면 index.html 폴백 (SPA 라우팅)
      const idxPath = path.join(__dirname, 'index.html');
      fs.stat(idxPath, (s2Err, s2) => {
        if (s2Err) { res.writeHead(404); res.end('Not found'); return; }
        fs.readFile(idxPath, (e2, idx) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          serveFile(idxPath, idx, s2);
        });
      });
      return;
    }
    fs.readFile(fullPath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Read error'); return; }
      serveFile(fullPath, data, stat);
    });
  });
});

server.listen(PORT, () => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  console.log('\n🎯  SEEA Precision 서버 시작');
  console.log(`    URL : http://localhost:${PORT}`);
  console.log(`    API : ${hasKey ? '✅  연결됨 (gemini-2.0-flash)' : '⚠️   GEMINI_API_KEY 없음 → UI 전용 모드'}`);
  if (!hasKey) console.log('    →  .env 파일에 GEMINI_API_KEY=AIza... 를 추가하세요');
  console.log('\n    브라우저에서 http://localhost:3000 을 열어주세요\n');

  // 서버 시작 후 PDF 업로드 (비동기 — 서버 구동을 막지 않음)
  if (hasKey) {
    uploadRulesPDF();
    // 48시간 만료 전에 24시간마다 재업로드
    setInterval(() => {
      console.log('    🔄 규정집 24시간 자동 재업로드 중...');
      rulesFileUri = null;
      uploadRulesPDF();
    }, 24 * 60 * 60 * 1000);
  }

  // 진행중 대회 순위 캐시 워밍 — 동시 6개로 제한해 KSF 부담 최소화.
  // 이미 신선한 항목은 건너뛴다(20분 재워밍 시 중복 fetch 방지).
  const warmRankingsFor = async (comp) => {
    try {
      const { html = '', events = [] } = await getGamePageHtml(comp);
      // 종목 목록 캐시도 함께 채움 — 재시작 후 첫 결과조회도 즉시(getGamePageHtml 재호출 방지)
      const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const seen = new Set();
      const unique = [];
      for (const evt of events) {
        const key = evt.personUrl || `${evt.eventLabel}|${evt.scheduleDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
          eventLabel:   normalizeEventLabel(evt.eventLabel),
          personUrl:    evt.personUrl,
          groupUrl:     evt.groupUrl,
          scheduleDate: evt.scheduleDate,
          scheduleTime: evt.scheduleTime,
        });
      }
      compEventsCache.set(comp, { data: { comp, title: titleM ? titleM[1].trim() : comp, events: unique }, ts: Date.now() });

      const urls = [...new Set(events.flatMap(e => [e.personUrl, e.groupUrl].filter(Boolean)))];
      let i = 0, warmed = 0;
      const worker = async () => {
        while (i < urls.length) {
          const url = urls[i++];
          const c = rankingsCache.get(url);
          if (c && Date.now() - c.ts < RANK_FRESH) { warmed++; continue; }
          try { await _fetchRankings(url); warmed++; } catch {}
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      console.log(`[PREWARM] ${comp} 순위 ${warmed}/${urls.length}건 워밍`);
    } catch (e) { console.log(`[PREWARM] ${comp} 순위 워밍 실패: ${e.message}`); }
  };

  // 진행중 대회 자동 캐시 pre-warm (서버 재시작 후 첫 검색·결과도 빠르게)
  const warmOngoing = () => getCompList().then(comps => {
    const ongoing = comps.filter(c => c.status === 'ongoing');
    if (ongoing.length === 0) return;
    console.log(`[PREWARM] 진행중 대회 ${ongoing.length}개 캐시 워밍 시작...`);
    for (const comp of ongoing) {
      searchBib(comp.jname, '', 'name').then(result => {
        if (result.ok && result.allPlayers?.length) {
          compPlayersCache.set(comp.jname, { players: injectBirthYears(result.allPlayers), ts: Date.now() });
          saveBibCacheToDisk();
          console.log(`[PREWARM] ${comp.jname} (${comp.name}) 완료 — ${result.allPlayers.length}명`);
        }
      }).catch(e => console.log(`[PREWARM] ${comp.jname} 실패: ${e.message}`));
      warmRankingsFor(comp.jname);  // 순위도 백그라운드 워밍
    }
  }).catch(e => console.log(`[PREWARM] 대회 목록 조회 실패: ${e.message}`));

  warmOngoing();
  // 20분마다 재워밍 (진행중 대회 데이터 최신 유지)
  setInterval(warmOngoing, 20 * 60 * 1000);

  // KSF 대회 목록 감시 시작
  startWatcher();
});
