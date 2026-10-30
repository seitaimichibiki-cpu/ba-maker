/**
 * BAメーカー 自動BGM生成エンジン（Web Audio API シンセサイザー）
 * 外部音源不使用・著作権フリーの明るいアップテンポBGMをシード値から決定論的に自動作曲・再生します。
 */
(() => {
  "use strict";

  let sharedCtx = null;
  let noiseBuf = null;

  function ensureContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error("このブラウザは音声合成（Web Audio API）に非対応です。");
    if (!sharedCtx || sharedCtx.state === "closed") {
      sharedCtx = new AC();
      noiseBuf = null;
    }
    if (sharedCtx.state === "suspended") {
      sharedCtx.resume().catch(() => {});
    }
    return sharedCtx;
  }

  function getNoiseBuffer(ctx) {
    if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let s = 123456789;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = (s / 2147483648) - 1;
    }
    noiseBuf = buf;
    return buf;
  }

  // シード固定PRNG（同じ番号なら試聴と保存で100%同じ曲を再現）
  function mulberry32(seed) {
    let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0);
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // 滑らかなボイスリーディングを持つダイアトニックコード定義
  const CHORDS = {
    I:   { bass: 0,  voicing: [0, 4, 7, 12] },
    ii:  { bass: 2,  voicing: [2, 5, 9, 12] },
    iii: { bass: 4,  voicing: [4, 7, 11, 14] },
    IV:  { bass: 5,  voicing: [0, 5, 9, 12] },
    V:   { bass: 7,  voicing: [2, 7, 11, 14] },
    vi:  { bass: -3, voicing: [0, 4, 9, 12] }
  };

  const STYLES = [
    { name: "爽やかポップ",   prog: ["I", "V", "vi", "IV"],   bpmRange: [124, 128], leadWave: "triangle" },
    { name: "アップビート",   prog: ["IV", "V", "iii", "vi"], bpmRange: [128, 132], leadWave: "triangle" },
    { name: "サンシャイン",   prog: ["vi", "IV", "I", "V"],   bpmRange: [122, 126], leadWave: "sine" },
    { name: "ポジティブ",     prog: ["I", "IV", "vi", "V"],   bpmRange: [126, 130], leadWave: "triangle" },
    { name: "ブライトダンス", prog: ["IV", "I", "V", "vi"],   bpmRange: [128, 134], leadWave: "triangle" },
    { name: "フレッシュ",     prog: ["I", "iii", "IV", "V"],  bpmRange: [124, 130], leadWave: "sine" }
  ];

  const KEYS = [60, 62, 63, 65, 67]; // C, D, Eb, F, G Major

  const CHORD_RHYTHMS = [
    [[0, 3, 1.0], [3, 3, 0.9], [6, 4, 0.95], [10, 2, 0.8], [12, 4, 0.95]],
    [[0, 3, 1.0], [3, 3, 0.88], [6, 2, 0.8], [8, 4, 0.95], [12, 4, 0.9]],
    [[0, 2, 1.0], [2, 2, 0.55], [4, 2, 0.85], [6, 2, 0.55], [8, 2, 0.95], [10, 2, 0.55], [12, 2, 0.85], [14, 2, 0.6]],
    [[0, 4, 1.0], [6, 4, 0.92], [10, 2, 0.82], [12, 4, 0.95]]
  ];

  const BASS_RHYTHMS = [
    [[0, 2, 0, 0], [2, 2, 1, 0], [4, 2, 0, 0], [6, 2, 1, 0], [8, 2, 0, 0], [10, 2, 1, 0], [12, 2, 0, 0], [14, 2, 1, 1]],
    [[0, 3, 0, 0], [3, 3, 0, 0], [6, 2, 1, 0], [8, 3, 0, 0], [11, 3, 0, 1], [14, 2, 1, 0]],
    [[0, 2, 0, 0], [2, 2, 0, 0], [4, 2, 1, 0], [6, 2, 0, 0], [8, 2, 0, 0], [10, 2, 0, 1], [12, 2, 1, 0], [14, 2, 0, 0]]
  ];

  const MEL_RHYTHMS = [
    [0, 3, 6, 8, 10, 12],
    [0, 2, 4, 7, 10, 12, 14],
    [0, 3, 6, 10, 12, 14],
    [2, 4, 6, 9, 12, 14],
    [0, 4, 6, 8, 11, 14]
  ];

  const PENTA = [7, 9, 12, 14, 16, 19, 21]; // メジャーペンタトニック（どのコード上でも協和）

  function buildSong(seed) {
    const n = Math.max(1, parseInt(seed, 10) || 1);
    const rnd = mulberry32(n);
    const style = STYLES[(n - 1) % STYLES.length];
    const bpm = style.bpmRange[0] + Math.floor(rnd() * (style.bpmRange[1] - style.bpmRange[0] + 1));
    const keyRoot = KEYS[Math.floor(rnd() * KEYS.length)];
    const chordRhythm = CHORD_RHYTHMS[Math.floor(rnd() * CHORD_RHYTHMS.length)];
    const bassRhythm = BASS_RHYTHMS[Math.floor(rnd() * BASS_RHYTHMS.length)];
    const melSteps = MEL_RHYTHMS[Math.floor(rnd() * MEL_RHYTHMS.length)];
    const hat16 = rnd() > 0.45;
    const fillStep = rnd() > 0.5 ? 14 : 15;

    // 4小節（64ステップ）のキャッチーな反復メロディ生成（A - A' - A - B）
    const motifA = [];
    let idx = 2 + Math.floor(rnd() * 3); // 主音〜3度付近から開始
    const deltas = [-2, -1, -1, 1, 1, 2];
    for (let i = 0; i < melSteps.length; i++) {
      if (i > 0) {
        idx = Math.max(0, Math.min(PENTA.length - 1, idx + deltas[Math.floor(rnd() * deltas.length)]));
      }
      const nextStep = i + 1 < melSteps.length ? melSteps[i + 1] : 16;
      motifA.push({ step: melSteps[i], note: PENTA[idx], len: Math.min(4, nextStep - melSteps[i]) });
    }

    const motifA2 = motifA.map((m, i) => {
      if (i >= motifA.length - 2) {
        const alt = Math.max(0, Math.min(PENTA.length - 1, idx + (i % 2 === 0 ? 1 : -1)));
        return { ...m, note: PENTA[alt] };
      }
      return m;
    });

    // 4小節目は安定音（主音+12 または 3度+16）へ気持ちよく着地
    const motifB = [];
    for (let i = 0; i < Math.min(3, motifA.length); i++) motifB.push(motifA[i]);
    const resolveNote = rnd() > 0.35 ? 12 : 16;
    motifB.push({ step: 10, note: 14, len: 2 });
    motifB.push({ step: 12, note: resolveNote, len: 4 });

    const bars = [motifA, motifA2, motifA, motifB];

    // 64ステップ分のイベントマップへ展開
    const chordMap = Array.from({ length: 64 }, () => null);
    const bassMap = Array.from({ length: 64 }, () => null);
    const melMap = Array.from({ length: 64 }, () => null);

    for (let bar = 0; bar < 4; bar++) {
      const ch = CHORDS[style.prog[bar]];
      const base = bar * 16;
      chordRhythm.forEach(([st, len, vel]) => {
        chordMap[base + st] = { notes: ch.voicing.map(v => keyRoot + v), len, vel };
      });
      bassRhythm.forEach(([st, len, oct, fifth]) => {
        const semi = ch.bass + (oct ? 12 : 0) + (fifth ? 7 : 0);
        bassMap[base + st] = { midi: keyRoot - 24 + semi, len };
      });
      bars[bar].forEach((m) => {
        if (m.step < 16) melMap[base + m.step] = { midi: keyRoot + m.note, len: m.len };
      });
    }

    return {
      seed: n,
      styleName: style.name,
      bpm,
      leadWave: style.leadWave,
      hat16,
      fillStep,
      chordMap,
      bassMap,
      melMap,
      title: `${style.name} #${n}（${bpm} BPM）`
    };
  }

  function describeTrack(seed) {
    const s = buildSong(seed);
    return { seed: s.seed, title: s.title, bpm: s.bpm, styleName: s.styleName };
  }

  // ---------- 音源シンセサイザー各パート ----------
  function playKick(ctx, dest, t, gainMul) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(155, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.075);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.72 * gainMul, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g);
    g.connect(dest);
    osc.onended = () => g.disconnect();
    osc.start(t);
    osc.stop(t + 0.23);
  }

  function playClap(ctx, dest, t) {
    // ノイズ成分
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(1550, t);
    bp.Q.setValueAtTime(1.1, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.onended = () => { bp.disconnect(); g.disconnect(); };
    src.start(t, 0, 0.15);

    // スネアの芯
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(210, t);
    osc.frequency.exponentialRampToValueAtTime(115, t + 0.045);
    og.gain.setValueAtTime(0.16, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
    osc.connect(og);
    og.connect(dest);
    osc.onended = () => og.disconnect();
    osc.start(t);
    osc.stop(t + 0.07);
  }

  function playHat(ctx, dest, t, open) {
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(7000, t);
    const g = ctx.createGain();
    const dur = open ? 0.085 : 0.032;
    const peak = open ? 0.14 : 0.07;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(hp);
    hp.connect(g);
    g.connect(dest);
    src.onended = () => { hp.disconnect(); g.disconnect(); };
    src.start(t, open ? 0.2 : 0.5, dur + 0.02);
  }

  function playBass(ctx, dest, t, midi, durSec) {
    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(mtof(midi), t);
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(520, t);
    lp.frequency.exponentialRampToValueAtTime(210, t + Math.min(0.16, durSec));
    lp.Q.setValueAtTime(1.4, t);
    const d = Math.max(0.06, durSec * 0.88);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    osc.connect(lp);
    lp.connect(g);
    g.connect(dest);
    osc.onended = () => { lp.disconnect(); g.disconnect(); };
    osc.start(t);
    osc.stop(t + d + 0.01);
  }

  function playChord(ctx, dest, t, midis, durSec, vel) {
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(680, t + Math.min(0.24, durSec));
    const d = Math.max(0.09, durSec * 0.92);
    const peak = 0.085 * (vel || 1);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    lp.connect(g);
    g.connect(dest);

    let alive = midis.length;
    midis.forEach((m, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "triangle" : "sawtooth";
      osc.detune.setValueAtTime((i - 1.5) * 4, t); // 軽いコーラス感で温かみを付与
      osc.frequency.setValueAtTime(mtof(m), t);
      osc.connect(lp);
      osc.onended = () => {
        alive -= 1;
        if (alive <= 0) { lp.disconnect(); g.disconnect(); }
      };
      osc.start(t);
      osc.stop(t + d + 0.015);
    });
  }

  function playLead(ctx, dryDest, wetDest, t, midi, durSec, wave) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = wave || "triangle";
    osc.frequency.setValueAtTime(mtof(midi), t);
    const d = Math.max(0.09, durSec * 0.95);
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    osc.connect(g);
    g.connect(dryDest);
    g.connect(wetDest);
    osc.onended = () => g.disconnect();
    osc.start(t);
    osc.stop(t + d + 0.015);
  }

  // ---------- 再生セッション開始 ----------
  function start(ctx, targetNode, opts) {
    opts = opts || {};
    const song = buildSong(opts.seed || 1);
    const stepDur = 60 / song.bpm / 4; // 16分音符の秒数
    let vol = typeof opts.volume === "number" ? opts.volume : 0.7;

    // マスターバス → コンプレッサー → 出力ゲイン
    const mixBus = ctx.createGain();
    mixBus.gain.value = 1.0;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;

    const outGain = ctx.createGain();
    const startTime = ctx.currentTime + 0.03;
    outGain.gain.setValueAtTime(Math.max(0.0001, vol * 0.85), startTime);

    // 書き出し秒数が指定されている場合は終了0.8秒前から自然にフェードアウト
    if (opts.durationSec && opts.durationSec > 1.2) {
      const fadeStart = startTime + Math.max(0.4, opts.durationSec - 0.85);
      const fadeEnd = startTime + opts.durationSec;
      outGain.gain.setValueAtTime(Math.max(0.0001, vol * 0.85), fadeStart);
      outGain.gain.linearRampToValueAtTime(0.0001, fadeEnd);
    }

    // リード用付点8分ディレイ（空間の広がり）
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0.22;
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = Math.min(1.2, stepDur * 3);
    const delayFilter = ctx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 2200;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.26;

    delaySend.connect(delay);
    delay.connect(delayFilter);
    delayFilter.connect(mixBus);
    delayFilter.connect(delayFb);
    delayFb.connect(delay);

    mixBus.connect(comp);
    comp.connect(outGain);
    outGain.connect(targetNode);

    let step = 0;
    let nextTime = startTime;
    let stopped = false;
    const maxTime = opts.durationSec ? startTime + opts.durationSec + 0.1 : Infinity;

    function scheduleStep(st, t) {
      const s64 = st % 64;
      const s16 = st % 16;

      // 4つ打ちキック ＋ 4小節目末の軽いフィル
      if (s16 % 4 === 0) playKick(ctx, mixBus, t, 1.0);
      else if (s64 === 48 + song.fillStep) playKick(ctx, mixBus, t, 0.72);

      // 2拍目・4拍目クラップ
      if (s16 === 4 || s16 === 12) playClap(ctx, mixBus, t);

      // ハイハット（裏拍オープン ＋ 8分または16分クローズ）
      if (s16 % 4 === 2) playHat(ctx, mixBus, t, true);
      else if (s16 % 2 === 0 || (song.hat16 && s16 % 2 === 1)) playHat(ctx, mixBus, t, false);

      // ベース
      const bEv = song.bassMap[s64];
      if (bEv) playBass(ctx, mixBus, t, bEv.midi, bEv.len * stepDur);

      // コード
      const cEv = song.chordMap[s64];
      if (cEv) playChord(ctx, mixBus, t, cEv.notes, cEv.len * stepDur, cEv.vel);

      // メロディ
      const mEv = song.melMap[s64];
      if (mEv) playLead(ctx, mixBus, delaySend, t, mEv.midi, mEv.len * stepDur, song.leadWave);
    }

    function scheduler() {
      if (stopped) return;
      const horizon = ctx.currentTime + 0.16;
      while (nextTime < horizon && nextTime < maxTime) {
        scheduleStep(step, nextTime);
        nextTime += stepDur;
        step += 1;
      }
    }

    scheduler();
    const timer = setInterval(scheduler, 45);

    return {
      song,
      setVolume(v) {
        vol = v;
        if (!stopped && !opts.durationSec) {
          outGain.gain.setTargetAtTime(Math.max(0.0001, vol * 0.85), ctx.currentTime, 0.03);
        }
      },
      stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try {
          const now = ctx.currentTime;
          outGain.gain.cancelScheduledValues(now);
          outGain.gain.setValueAtTime(Math.max(0.0001, outGain.gain.value), now);
          outGain.gain.linearRampToValueAtTime(0.0001, now + 0.04);
        } catch (e) {}
        setTimeout(() => {
          try {
            delaySend.disconnect();
            delay.disconnect();
            delayFilter.disconnect();
            delayFb.disconnect();
            mixBus.disconnect();
            comp.disconnect();
            outGain.disconnect();
          } catch (e) {}
        }, 120);
      }
    };
  }

  window.BAM_BGM = { ensureContext, describeTrack, start };
})();
