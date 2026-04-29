/**
 * KSF (대한사격연맹) 사대번호 스크래퍼
 * 출처: https://www.shooting.or.kr/score/score_2015_game.asp?jname=N01H
 *
 * 실제 컬럼 순서 (score_2015_player.asp):
 *   사대번호(X-Y) | 단체여부 | 소속 | 이름
 */

const KSF_BASE = 'https://www.shooting.or.kr';
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Referer':    'https://www.shooting.or.kr',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// ── HTML fetch (EUC-KR 우선 처리) ─────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);

  const buf = await res.arrayBuffer();

  // 1차: Content-Type 헤더에서 charset 확인
  const ct      = res.headers.get('content-type') || '';
  let   charset = (ct.match(/charset=([^\s;]+)/i) || [])[1] || '';

  // 2차: EUC-KR로 시도해서 meta charset 읽기 (KSF는 EUC-KR 사용)
  if (!charset) {
    try {
      const latin  = Buffer.from(buf).toString('latin1');
      const metaM  = latin.match(/charset=["']?([a-zA-Z0-9_-]+)/i);
      if (metaM) charset = metaM[1];
    } catch { /* */ }
  }

  // 3차: 기본값 euc-kr (KSF 사이트 기준)
  if (!charset) charset = 'euc-kr';

  charset = charset.toLowerCase().replace('ks_c_5601-1987', 'euc-kr');

  let html = '';
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    // TextDecoder가 euc-kr을 지원 못 하면 latin1 → manual recode
    html = Buffer.from(buf).toString('binary');
  }

  // 디버그: charset 확인
  console.log(`  [fetch] charset=${charset}, bytes=${buf.byteLength}, snippet="${html.slice(0, 80).replace(/\n/g,' ')}"`);
  return html;
}

// ── HTML에서 텍스트만 추출 ──────────────────────────────
function stripTags(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&#\d+;/g,  '')
    .replace(/\s+/g,     ' ')
    .trim();
}

// ── 선수목록 페이지 파싱 ────────────────────────────────
//  컬럼: [사대번호 X-Y] [단체여부] [소속] [이름]
function parsePlayerTable(html, eventLabel) {
  const players = [];

  // 전체 HTML에서 <td> 텍스트를 순서대로 추출
  const allTds = [];
  for (const m of html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    allTds.push(stripTags(m[1]).trim());
  }

  // 사대번호 패턴: "2-72" 또는 "2 - 72" (공백 포함) 모두 허용
  const BIB_RE = /^\d{1,3}\s*[-–]\s*\d{1,4}$/;

  for (let i = 0; i < allTds.length; i++) {
    const bib = allTds[i];
    if (!BIB_RE.test(bib)) continue;

    // 다음 BIB 패턴이 나오기 전까지만 같은 행의 셀로 간주 (최대 6칸)
    const rowCells = [];
    for (let j = i + 1; j < allTds.length && j <= i + 6; j++) {
      if (BIB_RE.test(allTds[j])) break; // 다음 행 시작 → 중단
      rowCells.push(allTds[j]);
    }

    const nonEmpty = rowCells.filter(v => v !== '');

    let teamType    = '';
    let affiliation = '';
    let name        = '';

    // KSF 실제 구조: 단체여부(없을 수도) | 소속 | 이름
    if (nonEmpty.length >= 3) {
      teamType    = nonEmpty[0]; // "단체" 또는 ""
      affiliation = nonEmpty[nonEmpty.length - 2];
      name        = nonEmpty[nonEmpty.length - 1];
    } else if (nonEmpty.length === 2) {
      affiliation = nonEmpty[0];
      name        = nonEmpty[1];
    } else if (nonEmpty.length === 1) {
      name = nonEmpty[0];
    }

    // 빈 이름, 순수 숫자, 또 다른 사대번호 패턴이면 제외
    if (!name || /^\d+$/.test(name) || BIB_RE.test(name)) continue;

    // 사대번호 정규화: 공백 제거, 하이픈 통일
    const bibNorm = bib.replace(/\s+/g, '').replace(/[–—]/g, '-');
    const [group = '', lane = ''] = bibNorm.split('-');
    players.push({ event: eventLabel, bib: bibNorm, group, lane, name, affiliation, teamType });
  }

  console.log(`    [parse] td수=${allTds.length}, 선수=${players.length}명` +
    (players.length > 0 ? `, 샘플: ${players[0].name}(${players[0].bib})` : ''));
  return players;
}

// ── 게임 페이지에서 (이벤트명, URL) 쌍 추출 ─────────────
function parseGameLinks(html) {
  const seen    = new Set();
  const results = [];

  for (const m of html.matchAll(/["']((?:https?:\/\/[^"']*)?(?:\/score\/)?score_2015_player\.asp\?[^"']+)["']/gi)) {
    let href = m[1];
    if (!href.startsWith('http')) {
      href = `${KSF_BASE}${href.startsWith('/') ? '' : '/score/'}${href}`;
    }
    if (seen.has(href)) continue;
    seen.add(href);

    // 파라미터 파싱으로 이벤트 라벨 생성
    const qs = href.includes('?') ? href.split('?')[1] : '';
    const p  = new URLSearchParams(qs);
    const sex = p.get('sex') || '';
    const bb  = p.get('bb')  || '';
    const i1  = p.get('i1')  || '';

    const sexLabel = sex === '2' ? '여자' : '남자';
    const bbMap    = { '1':'초등부','2':'중등부','3':'고등부','4':'대학부','5':'일반부','6':'중급부','7':'초급부' };
    const bbLabel  = bbMap[bb] || `bb${bb}`;
    const i1Map    = {
      '11':'10m 공기소총','12':'10m 공기권총',
      '13':'50m 소총 3자세','14':'50m 소총 복사','15':'50m 소총 3자세',
      '21':'50m 소총 복사','22':'50m 소총 복사(부복사)',
      '23':'10m 러닝타겟',
      '24':'50m 소총 복사',
      '25':'50m 소총 3자세',
      '26':'25m 권총','27':'25m 스포츠 권총',
      '31':'트랩','32':'스키트','33':'더블트랩',
      '41':'10m 공기소총(장애)','42':'10m 공기권총(장애)',
      '81':'10m 공기소총','82':'10m 공기권총',
    };
    const i1Label  = i1Map[i1] || `종목${i1}`;
    const label    = `${i1Label} ${sexLabel} ${bbLabel}`.trim();

    results.push({ eventLabel: label, playerUrl: href });
  }
  return results;
}

// ── 메인: 대회코드 + 이름으로 사대번호 검색 ─────────────
export async function searchBib(compCode, searchName) {
  console.log(`\n[BIB] ▶ 검색 시작 — 대회: ${compCode}, 이름: "${searchName}"`);

  const gameUrl  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const gameHtml = await fetchHtml(gameUrl);
  const events   = parseGameLinks(gameHtml);

  console.log(`[BIB] 종목 ${events.length}개 발견`);
  if (events.length === 0) {
    return { ok: false, error: '종목 링크를 찾을 수 없습니다. 사대배정표가 아직 게시되지 않았을 수 있습니다.' };
  }

  // 병렬 fetch
  const fetched = await Promise.allSettled(
    events.map(async ({ eventLabel, playerUrl }) => {
      try {
        const html    = await fetchHtml(playerUrl);
        const players = parsePlayerTable(html, eventLabel);
        const sample  = players.slice(0, 3).map(p => p.name).join(', ');
        console.log(`[BIB]   ${eventLabel} → ${players.length}명 ${sample ? `[${sample}]` : '(없음)'}`);
        return players;
      } catch (e) {
        console.log(`[BIB]   ${eventLabel} → 오류: ${e.message}`);
        return [];
      }
    })
  );

  const allPlayers = fetched
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  console.log(`[BIB] 총 ${allPlayers.length}명 파싱 완료`);

  const matched = allPlayers.filter(p => p.name.includes(searchName));
  console.log(`[BIB] "${searchName}" 검색 결과: ${matched.length}건`);

  return { ok: true, total: allPlayers.length, matched };
}

export async function getCompInfo(compCode) {
  const gameUrl  = `${KSF_BASE}/score/score_2015_game.asp?jname=${compCode}`;
  const gameHtml = await fetchHtml(gameUrl);
  const title    = (gameHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '';
  const events   = parseGameLinks(gameHtml);
  return { compCode, title, eventCount: events.length };
}
