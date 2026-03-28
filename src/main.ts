import { getLoginStatus, createAudiotoolClient } from "@audiotool/nexus"

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID    = "b8ad1f01-3e09-4e01-bd6d-68322525e431"
const REDIRECT_URL = window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:5173/"
  : "https://snadbreugen.github.io/Matrix-Evolutions/"

// ── MIDI timing ───────────────────────────────────────────────────────────────
const AT_TICKS_PER_BAR    = 3840
const MIDI_TICKS_PER_BEAT = 480
const AT_PER_MIDI = AT_TICKS_PER_BAR / (MIDI_TICKS_PER_BEAT * 4) // = 2

// Machiniste stepScaleIndex → AT ticks per step
const STEP_SCALE: Record<number, number> = {
  1: 960,   // 1/16
  2: 480,   // 1/32
  3: 1280,  // 1/12 triplet
  4: 640,   // 1/24
}

// Machiniste: first 5 channels → GM drum pitches
const MAC_CHANNELS: { name: string; pitch: number }[] = [
  { name: "Kick",        pitch: 36 },
  { name: "Snare",       pitch: 38 },
  { name: "HiHat Cl",   pitch: 42 },
  { name: "HiHat Op",   pitch: 46 },
  { name: "Crash",       pitch: 49 },
]

// ── MIDI file builder ─────────────────────────────────────────────────────────
function varLen(v: number): number[] {
  const b = [v & 0x7f]; v >>= 7
  while (v > 0) { b.unshift((v & 0x7f) | 0x80); v >>= 7 }
  return b
}
const b32 = (v: number) => [(v>>24)&0xff,(v>>16)&0xff,(v>>8)&0xff,v&0xff]
const b16 = (v: number) => [(v>>8)&0xff, v&0xff]

interface MidiNote  { pitch: number; velocity: number; startTick: number; durationTicks: number }
interface MidiTrack { name: string; notes: MidiNote[]; channel: number }

function buildMidi(tracks: MidiTrack[], bpm: number): Uint8Array {
  const uspb = Math.round(60_000_000 / bpm)
  const hdr  = [0x4d,0x54,0x68,0x64,...b32(6),...b16(1),...b16(tracks.length+1),...b16(MIDI_TICKS_PER_BEAT)]
  const tdat = [0x00,0xff,0x51,0x03,...b32(uspb).slice(1),0x00,0xff,0x2f,0x00]
  const ttrk = [0x4d,0x54,0x72,0x6b,...b32(tdat.length),...tdat]

  const noteTraks = tracks.map(tr => {
    const ch  = tr.channel & 0x0f
    const evs: { tick: number; data: number[] }[] = []
    const nb  = Array.from(new TextEncoder().encode(tr.name))
    evs.push({ tick: 0, data: [0xff,0x03,...varLen(nb.length),...nb] })

    for (const n of tr.notes) {
      const s = Math.round(n.startTick / AT_PER_MIDI)
      const e = Math.round((n.startTick + n.durationTicks) / AT_PER_MIDI)
      const v = Math.min(127, Math.max(1, n.velocity))
      evs.push({ tick: s, data: [0x90|ch, n.pitch&0x7f, v] })
      evs.push({ tick: e, data: [0x80|ch, n.pitch&0x7f, 0] })
    }
    evs.sort((a,b) => a.tick - b.tick)

    const td: number[] = []; let last = 0
    for (const ev of evs) { td.push(...varLen(ev.tick-last),...ev.data); last = ev.tick }
    td.push(0x00,0xff,0x2f,0x00)
    return [0x4d,0x54,0x72,0x6b,...b32(td.length),...td]
  })

  return new Uint8Array([...hdr,...ttrk,...noteTraks.flat()])
}

function saveMidi(bytes: Uint8Array, name: string) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([bytes], { type: "audio/midi" })),
    download: name,
  }); a.click(); URL.revokeObjectURL(a.href)
}

// ── App state ─────────────────────────────────────────────────────────────────
interface TrackData extends MidiTrack { type: "note"|"drum"; noteCount: number }
let loadedTracks: TrackData[] = []
let projectSlug = "project"

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;400;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a12;--bg2:#0f0f1c;--bg3:#14142a;
  --neon:#00f5c4;--neon2:#7b61ff;--neon3:#ff2d6b;
  --border:rgba(0,245,196,0.18);--border2:rgba(123,97,255,0.25);
  --text:#e2e8f0;--muted:#5a6080;
  --mono:'Share Tech Mono',monospace;--sans:'Exo 2',sans-serif;
}
body{font-family:var(--sans);background:var(--bg);color:var(--text);min-height:100vh}
input,button{font-family:var(--sans)}
.topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px}
.logo-text{font-family:var(--mono);color:var(--neon);font-size:14px;letter-spacing:2px}
.logo-sub{display:block;font-family:var(--mono);color:var(--muted);font-size:9px;letter-spacing:3px;margin-top:2px}
.user-row{display:flex;align-items:center;gap:8px}
.avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--neon2),var(--neon3));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;font-family:var(--mono);flex-shrink:0}
.uname{font-family:var(--mono);font-size:12px;color:var(--neon)}
.btn-logout{background:none;border:1px solid rgba(255,45,107,.35);color:rgba(255,45,107,.75);border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:var(--mono)}
.btn-logout:hover{background:rgba(255,45,107,.1)}
.main{padding:28px 24px;max-width:700px;margin:0 auto;padding-bottom:80px}
.lbl{font-family:var(--mono);font-size:10px;letter-spacing:3px;color:var(--muted);text-transform:uppercase;margin-bottom:8px}
.url-row{display:flex;gap:10px;margin-bottom:22px}
.url-in{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 14px;color:var(--text);font-family:var(--mono);font-size:13px;outline:none;transition:border .2s;min-width:0}
.url-in:focus{border-color:var(--neon)}
.url-in::placeholder{color:var(--muted)}
.btn-load{background:var(--neon2);color:#fff;border:none;border-radius:6px;padding:10px 22px;font-family:var(--mono);font-size:13px;cursor:pointer;white-space:nowrap}
.btn-load:hover{opacity:.85}
.btn-load:disabled{opacity:.4;cursor:not-allowed}
.opt-row{display:flex;align-items:flex-end;gap:20px;margin-bottom:22px;flex-wrap:wrap}
.radio-group{display:flex;gap:8px}
.rpill{display:flex;align-items:center;gap:7px;background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:7px 14px;cursor:pointer;font-size:13px;color:var(--muted);user-select:none}
.rpill.on{border-color:var(--neon);color:var(--neon);background:rgba(0,245,196,.06)}
.rdot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}
.rpill.on .rdot{background:var(--neon)}
.bpm-wrap{display:flex;align-items:center;gap:8px;margin-left:auto}
.bpm-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px}
.bpm-in{background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--neon);font-family:var(--mono);font-size:18px;width:72px;text-align:center;outline:none}
.bpm-in:focus{border-color:var(--neon)}
.div{height:1px;background:var(--border);margin-bottom:22px}
.trk-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.trk-cnt{font-family:var(--mono);font-size:12px;color:var(--muted)}
.trk-cnt em{color:var(--neon);font-style:normal}
.btn-all{background:none;border:1px solid var(--neon);color:var(--neon);border-radius:5px;padding:7px 16px;font-family:var(--mono);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px}
.btn-all:hover{background:rgba(0,245,196,.08)}
.trk-list{display:flex;flex-direction:column;gap:8px}
.tcard{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:flex;align-items:center;gap:12px;position:relative;overflow:hidden}
.tcard:hover{border-color:rgba(0,245,196,.35)}
.taccent{position:absolute;left:0;top:0;bottom:0;width:3px}
.tnum{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:24px;flex-shrink:0}
.tbadge{font-family:var(--mono);font-size:9px;letter-spacing:1px;padding:2px 6px;border-radius:3px;flex-shrink:0}
.b-note{background:rgba(123,97,255,.15);color:var(--neon2);border:1px solid rgba(123,97,255,.3)}
.b-drum{background:rgba(255,45,107,.12);color:var(--neon3);border:1px solid rgba(255,45,107,.25)}
.tinfo{flex:1;min-width:0}
.tname{font-size:14px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tmeta{font-family:var(--mono);font-size:11px;color:var(--muted);display:flex;gap:12px}
.bars{display:flex;align-items:flex-end;gap:2px;height:26px;flex-shrink:0}
.bar{width:4px;border-radius:1px}
.btn-dl{background:var(--bg3);border:1px solid var(--border2);color:var(--neon2);border-radius:5px;padding:6px 12px;font-family:var(--mono);font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.btn-dl:hover{background:rgba(123,97,255,.15)}
.statusbar{border-top:1px solid var(--border);padding:9px 24px;display:flex;align-items:center;gap:8px;position:fixed;bottom:0;left:0;right:0;background:var(--bg2)}
.sdot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.sdot.ok{background:var(--neon)}.sdot.err{background:var(--neon3)}.sdot.idle{background:var(--muted)}
.stxt{font-family:var(--mono);font-size:11px;color:var(--muted)}
.login-box{text-align:center;padding:72px 24px}
.login-box p{color:var(--muted);margin-bottom:24px;font-size:15px;line-height:1.6}
.btn-login{background:var(--neon2);color:#fff;border:none;border-radius:8px;padding:14px 36px;font-family:var(--mono);font-size:15px;cursor:pointer;letter-spacing:1px}
.btn-login:hover{opacity:.85}
`

// ── Logo ──────────────────────────────────────────────────────────────────────
function logoSvg() {
  return `<svg width="34" height="34" viewBox="0 0 34 34" fill="none">
    <circle cx="17" cy="17" r="15.5" stroke="#00f5c4" stroke-width="1" opacity=".35"/>
    <line x1="2" y1="17" x2="7" y2="17" stroke="#00f5c4" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="27" y1="17" x2="32" y2="17" stroke="#00f5c4" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M7 17 Q8.5 10 10.5 17 Q12.5 24 14.5 17 Q16.5 10 18.5 17 Q20.5 24 22.5 17 Q24 10 27 17"
      stroke="#00f5c4" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

// ── Mini bar chart ────────────────────────────────────────────────────────────
function miniBars(count: number, accent: string) {
  const h   = [14,20,10,24,16,8,22,12]
  const lit = Math.min(8, Math.round((count / 64) * 8))
  return `<div class="bars">${h.map((v,i) =>
    `<div class="bar" style="height:${v}px;background:${i<lit ? accent : "rgba(255,255,255,0.07)"}"></div>`
  ).join("")}</div>`
}

// ── Track card ────────────────────────────────────────────────────────────────
function trackCard(t: TrackData, i: number) {
  const ac    = t.type === "drum" ? "var(--neon3)" : "var(--neon2)"
  const litc  = t.type === "drum" ? "var(--neon3)" : "var(--neon)"
  const badge = t.type === "drum"
    ? `<span class="tbadge b-drum">DRUM</span>`
    : `<span class="tbadge b-note">NOTE</span>`
  const ch = t.type === "drum" ? "ch 10" : `ch ${t.channel + 1}`
  return `<div class="tcard">
    <div class="taccent" style="background:${ac}"></div>
    <div class="tnum">${String(i+1).padStart(2,"0")}</div>
    ${badge}
    <div class="tinfo">
      <div class="tname">${t.name}</div>
      <div class="tmeta"><span>${t.noteCount} events</span><span>${ch}</span></div>
    </div>
    ${miniBars(t.noteCount, litc)}
    <button class="btn-dl" data-idx="${i}">↓ .mid</button>
  </div>`
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg: string, type: "ok"|"err"|"idle" = "idle") {
  const el  = document.getElementById("stxt");  if (el)  el.textContent = msg
  const dot = document.getElementById("sdot");  if (dot) dot.className  = `sdot ${type}`
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <style>${CSS}</style>
    <div class="topbar">
      <div class="logo">
        ${logoSvg()}
        <div>
          <span class="logo-text">PACK MIDI</span>
          <span class="logo-sub">BY SNAD INDUSTRIES</span>
        </div>
      </div>
      <div id="user-area"></div>
    </div>
    <div class="main" id="main"></div>
    <div class="statusbar">
      <div class="sdot idle" id="sdot"></div>
      <span class="stxt" id="stxt">Verbinde...</span>
    </div>`

  setStatus("Verbinde mit Audiotool...")

  const status = await getLoginStatus({
    clientId: CLIENT_ID, redirectUrl: REDIRECT_URL, scope: "project:write",
  })

  if (!status.loggedIn) {
    setStatus("Nicht eingeloggt", "idle")
    document.getElementById("main")!.innerHTML = `
      <div class="login-box">
        <p>Login mit deinem Audiotool Account,<br>um MIDI-Noten und Drum-Patterns zu exportieren.</p>
        <button class="btn-login" id="btn-login">🔑 Login with Audiotool</button>
      </div>`
    document.getElementById("btn-login")!.onclick = () => status.login()
    return
  }

  // ── Logged in ──────────────────────────────────────────────────────────────
  const username = await status.getUserName()
  const initials = String(username).slice(0, 2).toUpperCase()

  document.getElementById("user-area")!.innerHTML = `
    <div class="user-row">
      <div class="avatar">${initials}</div>
      <span class="uname">${username}</span>
      <button class="btn-logout" id="btn-logout">logout</button>
    </div>`
  document.getElementById("btn-logout")!.onclick = () => status.logout()

  document.getElementById("main")!.innerHTML = `
    <div class="lbl">Project URL</div>
    <div class="url-row">
      <input class="url-in" id="url-in" type="text" placeholder="https://new.audiotool.com/user/track/..." />
      <button class="btn-load" id="btn-load">Load</button>
    </div>
    <div class="opt-row">
      <div>
        <div class="lbl" style="margin-bottom:8px">Export mode</div>
        <div class="radio-group">
          <div class="rpill on" id="pill-multi"><div class="rdot"></div>Multi-Track</div>
          <div class="rpill"    id="pill-single"><div class="rdot"></div>Per Track</div>
        </div>
      </div>
      <div class="bpm-wrap">
        <span class="bpm-lbl">BPM</span>
        <input class="bpm-in" id="bpm-in" type="number" value="120" min="20" max="300" />
      </div>
    </div>
    <div class="div"></div>
    <div id="trk-section" style="display:none">
      <div class="trk-hdr">
        <div>
          <div class="lbl" style="margin-bottom:4px">Tracks found</div>
          <div class="trk-cnt"><em id="trk-num">0</em> tracks ready</div>
        </div>
        <button class="btn-all" id="btn-all">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 1v8M3 6l3.5 3.5L10 6M1 11h11" stroke="#00f5c4" stroke-width="1.5" stroke-linecap="round"/>
          </svg>Export all
        </button>
      </div>
      <div class="trk-list" id="trk-list"></div>
    </div>`

  setStatus(`Eingeloggt als ${username}`, "ok")

  // Mode toggle
  let mode: "multi"|"single" = "multi"
  document.getElementById("pill-multi")!.onclick = () => {
    mode = "multi"
    document.getElementById("pill-multi")!.className = "rpill on"
    document.getElementById("pill-single")!.className = "rpill"
  }
  document.getElementById("pill-single")!.onclick = () => {
    mode = "single"
    document.getElementById("pill-single")!.className = "rpill on"
    document.getElementById("pill-multi")!.className  = "rpill"
  }

  // ── Load project ───────────────────────────────────────────────────────────
  document.getElementById("btn-load")!.onclick = async () => {
    const url = (document.getElementById("url-in") as HTMLInputElement).value.trim()
    if (!url) { setStatus("Bitte eine Projekt-URL eingeben", "err"); return }

    const loadBtn = document.getElementById("btn-load") as HTMLButtonElement
    loadBtn.disabled = true; loadBtn.textContent = "Loading..."
    setStatus("Lade Projekt...", "idle")
    document.getElementById("trk-section")!.style.display = "none"
    loadedTracks = []

    try {
      const client = await createAudiotoolClient({ authorization: status as any })
      const nexus  = await client.createSyncedDocument({ mode: "online", project: url })
      await nexus.start()

      projectSlug = url.split("/").filter(Boolean).pop()?.replace(/[^a-z0-9]/gi, "_") ?? "project"

      // ── 1. Note Tracks ─────────────────────────────────────────────────────
      const collections = nexus.queryEntities.ofTypes("noteCollection").get()
      const regions      = nexus.queryEntities.ofTypes("noteRegion").get()
      const noteTracks   = nexus.queryEntities.ofTypes("noteTrack").get()

      const collName = new Map<string, string>()
      for (const r of regions) {
        const cLoc = r.fields.collection.value?.toString() ?? ""
        const tLoc = r.fields.track.value?.toString() ?? ""
        const nt   = noteTracks.find(t => t.location.toString() === tLoc)
        if (cLoc) collName.set(cLoc, String(nt?.fields?.displayName?.value ?? `Track ${collName.size + 1}`))
      }

      let midiCh = 0
      for (const coll of collections) {
        const name  = collName.get(coll.location.toString()) ?? `Track ${midiCh + 1}`
        const raw   = coll.fields?.notes?.get?.() ?? []
        const notes: MidiNote[] = raw.map((n: any) => ({
          pitch:         n.fields?.pitch?.value         ?? n.pitch         ?? 60,
          velocity:      n.fields?.velocity?.value      ?? n.velocity      ?? 100,
          startTick:     n.fields?.positionTicks?.value ?? n.positionTicks ?? 0,
          durationTicks: n.fields?.durationTicks?.value ?? n.durationTicks ?? 240,
        }))
        loadedTracks.push({ name, notes, channel: midiCh, type: "note", noteCount: notes.length })
        midiCh++
      }

      // ── 2. Machiniste ──────────────────────────────────────────────────────
      const machines = nexus.queryEntities.ofTypes("machiniste").get()

      for (const mac of machines) {
        const macName = String(mac.fields?.displayName?.value ?? "Machiniste")

        // Collect all slot locations belonging to this machiniste
        const macSlots = new Set<string>()
        const slots = mac.fields?.patternSlots?.get?.() ?? []
        for (const slot of slots) {
          const loc = slot?.location?.toString() ?? slot?.toString() ?? ""
          if (loc) macSlots.add(loc)
        }

        // Find patterns that point to one of those slots
        const allPatterns  = nexus.queryEntities.ofTypes("machinistePattern").get()
        const myPatterns   = allPatterns.filter(p => {
          const slotLoc = p.fields?.slot?.value?.toString() ?? ""
          return macSlots.has(slotLoc)
        })

        // Export first 5 channels only
        for (let chIdx = 0; chIdx < 5; chIdx++) {
          const { name: chLabel, pitch } = MAC_CHANNELS[chIdx]
          const drumNotes: MidiNote[] = []
          let stepOffset = 0

          for (const pat of myPatterns) {
            const patLen      = Number(pat.fields?.length?.value ?? 16)
            const scaleIdx    = Number(pat.fields?.stepScaleIndex?.value ?? 1)
            const tickPerStep = STEP_SCALE[scaleIdx] ?? 960

            const chPats = pat.fields?.channelPatterns?.get?.() ?? []
            const chPat  = chPats[chIdx]
            if (!chPat) { stepOffset += patLen; continue }

            // Skip muted channels
            if (chPat.fields?.isMuted?.value === true) { stepOffset += patLen; continue }

            const steps = chPat.fields?.steps?.get?.() ?? []
            for (let si = 0; si < patLen; si++) {
              const step = steps[si]
              if (!step?.fields?.isActive?.value) continue

              // modulationDepth 0–1 → velocity 40–127
              const mod = Number(step.fields?.modulationDepth?.value ?? 1)
              const vel = Math.round(40 + mod * 87)

              drumNotes.push({
                pitch,
                velocity:      Math.min(127, Math.max(1, vel)),
                startTick:     (stepOffset + si) * tickPerStep,
                durationTicks: Math.max(10, tickPerStep - 20),
              })
            }
            stepOffset += patLen
          }

          if (drumNotes.length > 0) {
            loadedTracks.push({
              name:      `${macName} – ${chLabel}`,
              notes:     drumNotes,
              channel:   9,
              type:      "drum",
              noteCount: drumNotes.length,
            })
          }
        }
      }

      await nexus.stop()

      if (loadedTracks.length === 0) {
        setStatus("Keine Tracks mit Noten gefunden", "err")
        loadBtn.disabled = false; loadBtn.textContent = "Load"
        return
      }

      document.getElementById("trk-num")!.textContent            = String(loadedTracks.length)
      document.getElementById("trk-list")!.innerHTML             = loadedTracks.map(trackCard).join("")
      document.getElementById("trk-section")!.style.display      = "block"
      setStatus(`${loadedTracks.length} Track(s) geladen — bereit zum Export`, "ok")

      // Individual download buttons
      document.querySelectorAll<HTMLButtonElement>(".btn-dl").forEach(btn => {
        btn.addEventListener("click", () => {
          const t = loadedTracks[parseInt(btn.dataset.idx!)]
          saveMidi(buildMidi([t], getBpm()), `${projectSlug}_${t.name.replace(/[^a-z0-9]/gi,"_")}.mid`)
        })
      })

    } catch (err: any) {
      setStatus(`Fehler: ${err?.message ?? String(err)}`, "err")
      console.error(err)
    }

    loadBtn.disabled = false; loadBtn.textContent = "Load"
  }

  // ── Export all ─────────────────────────────────────────────────────────────
  document.getElementById("btn-all")!.onclick = () => {
    if (!loadedTracks.length) return
    const bpm = getBpm()
    if (mode === "multi") {
      saveMidi(buildMidi(loadedTracks, bpm), `${projectSlug}_all.mid`)
    } else {
      loadedTracks.forEach(t =>
        saveMidi(buildMidi([t], bpm), `${projectSlug}_${t.name.replace(/[^a-z0-9]/gi,"_")}.mid`)
      )
    }
    setStatus(`Export fertig — ${loadedTracks.length} Track(s)`, "ok")
  }
}

const getBpm = () =>
  parseInt((document.getElementById("bpm-in") as HTMLInputElement)?.value) || 120

main()