/**
 * Kalender Kerja Wilayah II — Google Apps Script backend
 * Data  : Google Sheets (Kegiatan, Lampiran, Komentar, Log)
 * Files : Google Drive (folder per bulan)
 */

const APP_NAME = 'Kalender Kerja Wilayah II';
const PROP = PropertiesService.getScriptProperties();

const SHEETS = {
  events: ['id', 'judul', 'deskripsi', 'mulai', 'selesai', 'jamMulai', 'jamSelesai', 'seharian',
    'lokasi', 'kategori', 'prioritas', 'status', 'peserta', 'checklist', 'tautan',
    'dibuatOleh', 'dibuatPada', 'diubahOleh', 'diubahPada', 'dihapus'],
  files: ['id', 'eventId', 'fileId', 'nama', 'mime', 'ukuran', 'url', 'oleh', 'pada', 'dihapus'],
  comments: ['id', 'eventId', 'oleh', 'pada', 'isi'],
  logs: ['waktu', 'pengguna', 'aksi', 'eventId', 'judul', 'detail'],
};
const SHEET_NAMES = { events: 'Kegiatan', files: 'Lampiran', comments: 'Komentar', logs: 'Log' };
const MAX_UPLOAD_MB = 25;

/* ---------------------------------------------------------------- web app */

/* Tampilan (Index.html) diambil langsung dari GitHub, jadi setiap push ke branch utama
 * aktif sendiri tanpa membuka Apps Script (cache maks. 10 menit).
 * ?segar=1 → ambil ulang sekarang · ?ui=lokal → pakai file Index di proyek ini. */
const UI_URL = 'https://raw.githubusercontent.com/shelanatasha-bhpmedan/Kalender-Kerja-Wilayah-II/claude/modern-work-calendar-multiuser-1kd1xx/Index.html';

function ambilUi_(segar) {
  const cache = CacheService.getScriptCache();
  if (!segar) {
    const n = Number(cache.get('ui_n') || 0);
    if (n) {
      const parts = cache.getAll(Array.apply(null, Array(n)).map(function (_, i) { return 'ui_' + i; }));
      const html = Array.apply(null, Array(n)).map(function (_, i) { return parts['ui_' + i] || ''; }).join('');
      if (html.length > 1000 && Object.keys(parts).length === n) return html;
    }
  }
  const res = UrlFetchApp.fetch(UI_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('GitHub ' + res.getResponseCode());
  const html = res.getContentText('UTF-8');
  if (html.indexOf('<html') < 0) throw new Error('Isi dari GitHub tidak valid');
  try {
    const size = 90000, obj = {};
    let i = 0;
    for (; i * size < html.length; i++) obj['ui_' + i] = html.slice(i * size, (i + 1) * size);
    obj.ui_n = String(i);
    cache.putAll(obj, 600);
  } catch (e) { /* cache penuh: tetap tampilkan */ }
  return html;
}

function doGet(e) {
  ensureSetup_();
  const p = (e && e.parameter) || {};
  let out;
  if (p.ui !== 'lokal') {
    try { out = HtmlService.createHtmlOutput(ambilUi_(p.segar === '1')); } catch (err) { console.warn('UI GitHub gagal: ' + err); }
  }
  if (!out) out = HtmlService.createTemplateFromFile('Index').evaluate();
  return out
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Jalankan sekali dari editor Apps Script (pemilik) untuk membuat Spreadsheet & folder Drive. */
function setup() {
  ensureSetup_();
  const ss = SpreadsheetApp.openById(PROP.getProperty('SHEET_ID'));
  const folder = DriveApp.getFolderById(PROP.getProperty('FOLDER_ID'));
  Logger.log('Spreadsheet : ' + ss.getUrl());
  Logger.log('Folder Drive: ' + folder.getUrl());
  Logger.log('Bagikan folder "' + folder.getName() + '" ke tim sebagai EDITOR agar semua bisa mengisi.');
}

function ensureSetup_() {
  if (PROP.getProperty('SHEET_ID') && PROP.getProperty('FOLDER_ID')) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (PROP.getProperty('SHEET_ID') && PROP.getProperty('FOLDER_ID')) return;
    const root = DriveApp.createFolder(APP_NAME);
    const files = root.createFolder('Lampiran');
    const ss = SpreadsheetApp.create(APP_NAME + ' — Database');
    DriveApp.getFileById(ss.getId()).moveTo(root);
    Object.keys(SHEETS).forEach(function (k, i) {
      const sh = i === 0 ? ss.getSheets()[0].setName(SHEET_NAMES[k]) : ss.insertSheet(SHEET_NAMES[k]);
      sh.getRange(1, 1, 1, SHEETS[k].length).setValues([SHEETS[k]])
        .setFontWeight('bold').setBackground('#6d5dfc').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    });
    PROP.setProperties({ SHEET_ID: ss.getId(), FOLDER_ID: files.getId(), ROOT_ID: root.getId(), VERSION: '1' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- helpers */

function ss_() { return SpreadsheetApp.openById(PROP.getProperty('SHEET_ID')); }
function sheet_(k) { return ss_().getSheetByName(SHEET_NAMES[k]); }
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function now_() { return new Date().toISOString(); }

function me_() {
  const email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || 'anonim';
  return email.toLowerCase();
}

function readAll_(k) {
  const sh = sheet_(k);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = SHEETS[k];
  return sh.getRange(2, 1, last - 1, cols.length).getDisplayValues().map(function (r, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c] = r[j]; });
    return o;
  });
}

function toRow_(k, obj) {
  return SHEETS[k].map(function (c) {
    const v = obj[c];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    // simpan sebagai teks agar tanggal/jam tidak diubah format oleh Sheets
    return typeof v === 'string' && /^[\d:\-+=]/.test(v) ? "'" + v : v;
  });
}

function bump_() {
  const v = Number(PROP.getProperty('VERSION') || 1) + 1;
  PROP.setProperty('VERSION', String(v));
  return v;
}

function log_(aksi, ev, detail) {
  sheet_('logs').appendRow(toRow_('logs', {
    waktu: now_(), pengguna: me_(), aksi: aksi,
    eventId: ev ? ev.id : '', judul: ev ? ev.judul : '', detail: detail || '',
  }));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function parseEvent_(e) {
  const o = Object.assign({}, e);
  ['checklist', 'peserta', 'tautan'].forEach(function (k) {
    try { o[k] = o[k] ? JSON.parse(o[k]) : []; } catch (err) { o[k] = []; }
  });
  o.seharian = String(o.seharian).toUpperCase() === 'TRUE';
  delete o._row;
  return o;
}

/* ---------------------------------------------------------------- API */

/* Agenda yang dimasukkan otomatis ke sheet Kegiatan (sekali saja per id; bila dihapus tidak dibuat ulang). */
const AGENDA_BAWAAN = [{
  id: 'agd-20261113-monitoring-pengampuan-ariel',
  judul: 'Rapat Monitoring Lanjutan Pengampuan an. Sdri. Ariel Ruth Agustin Aritonang',
  mulai: '2026-11-13', selesai: '2026-11-13', jamMulai: '10:00', jamSelesai: '12:00', seharian: false,
  lokasi: 'Daring — Zoom Meeting (ID 320 800 6444, kata sandi: bhpmedan)',
  kategori: 'Pengampuan', prioritas: 'Tinggi', status: 'Direncanakan', peserta: [],
  tautan: ['https://us06web.zoom.us/j/3208006444?pwd=d5NxplAXHqHGaOxgPbE3Zl2ebf1r7o.1&omn=85627561232'],
  deskripsi: [
    'Acara: Penyampaian hasil musyawarah keluarga.',
    'Rapat ini menindaklanjuti Rapat Monitoring Pengampuan tanggal 9 November 2026. Waktu dimulai pukul 10.00 WIB sampai selesai.',
    '',
    'ZOOM MEETING',
    '• Tautan: https://us06web.zoom.us/j/3208006444?pwd=d5NxplAXHqHGaOxgPbE3Zl2ebf1r7o.1&omn=85627561232',
    '• ID Rapat: 320 800 6444',
    '• Kata sandi: bhpmedan',
    '',
    'UNDANGAN (Medan, 9 November 2026, sifat Penting, ditandatangani Kepala BHP Medan Syafriadi Lubis)',
    '1. Bapak Janter Jameston Pangaribuan — W.2.AHU.AHU.1-AH.06.03-3688 (WAJIB HADIR)',
    '2. Ibu Jurnalita Pangaribuan — W.2.AHU.AHU.1-AH.06.03-3689 (WAJIB HADIR)',
    '3. Ibu Vera Minar Siagian — W.2.AHU.AHU.1-AH.06.03-3690 (WAJIB HADIR)',
    '4. Ibu Nora Sarmila Dewi Panjaitan (Pengampu) — W.2.AHU.AHU.1-AH.06.03-3691',
    'Tembusan: Direktur Jenderal Administrasi Hukum Umum Kementerian Hukum.',
    '',
    'CATATAN TINDAK LANJUT (WhatsApp, 12 November 2026)',
    'Ibu Vera, Ibu Jurnalita, dan Bapak Janter wajib hadir karena rapat ini menyangkut hak-hak keperdataan Sdri. Ariel Ruth ke depannya. BHP Medan ingin mendengar penjelasan dari pihak keluarga dekat lainnya sebagai bahan pertimbangan.',
    'Apabila Ibu Nora mengajukan pengunduran diri sebagai pengampu di pengadilan, BHP Medan memerlukan pertimbangan keluarga untuk memberikan rekomendasi kepada Hakim mengenai siapa yang berhak menjadi Pengampu Pengganti.',
    '',
    'STATUS KONFIRMASI KEHADIRAN (per 12 November 2026)',
    '• Ibu Jurnalita Pangaribuan: Hadir (polling WA)',
    '• Ibu Vera Minar Siagian: Hadir (polling WA)',
    '• Bapak Janter Jameston Pangaribuan: belum menjawab',
    '• Ibu Nora Sarmila Dewi Panjaitan: belum memilih di polling, sempat menelepon pukul 08.20',
  ].join('\n'),
  checklist: [
    { t: 'Kirim surat undangan resmi + tautan Zoom ke 4 pihak (9 Nov)', d: true },
    { t: 'Kirim pengingat & polling kehadiran via WhatsApp (12 Nov)', d: true },
    { t: 'Konfirmasi kehadiran Bapak Janter Jameston Pangaribuan', d: false },
    { t: 'Konfirmasi kehadiran Ibu Nora Sarmila Dewi Panjaitan (telepon balik)', d: false },
    { t: 'Buka ruang Zoom 15 menit lebih awal & cek rekaman', d: false },
    { t: 'Siapkan daftar hadir daring & notulen', d: false },
    { t: 'Catat hasil musyawarah keluarga & usulan Pengampu Pengganti', d: false },
    { t: 'Susun laporan/rekomendasi tindak lanjut kepada Kepala', d: false },
  ],
}];

function ensureAgenda_() {
  const done = JSON.parse(PROP.getProperty('AGENDA_DONE') || '[]');
  const todo = AGENDA_BAWAAN.filter(function (a) { return done.indexOf(a.id) < 0; });
  if (!todo.length) return;
  withLock_(function () {
    const ada = readAll_('events').map(function (e) { return e.id; });
    const t = now_();
    todo.forEach(function (a) {
      if (ada.indexOf(a.id) < 0) {
        const rec = Object.assign({}, a, { dibuatOleh: 'sistem', dibuatPada: t, diubahOleh: 'sistem', diubahPada: t, dihapus: false });
        sheet_('events').appendRow(toRow_('events', rec));
        log_('BUAT', rec, 'Agenda dimasukkan otomatis');
      }
      done.push(a.id);
    });
    PROP.setProperty('AGENDA_DONE', JSON.stringify(done));
    bump_();
  });
}

function apiBootstrap() {
  ensureSetup_();
  try { ensureAgenda_(); } catch (e) { console.warn('ensureAgenda_: ' + e); }
  const data = apiData();
  data.user = me_();
  data.rootUrl = 'https://drive.google.com/drive/folders/' + PROP.getProperty('ROOT_ID');
  data.sheetUrl = 'https://docs.google.com/spreadsheets/d/' + PROP.getProperty('SHEET_ID');
  data.maxUploadMb = MAX_UPLOAD_MB;
  return data;
}

function apiVersion() { return Number(PROP.getProperty('VERSION') || 1); }

function apiData() {
  const events = readAll_('events').filter(function (e) { return e.dihapus !== 'TRUE' && e.id; }).map(parseEvent_);
  const files = readAll_('files').filter(function (f) { return f.dihapus !== 'TRUE' && f.id; })
    .map(function (f) { delete f._row; return f; });
  const comments = readAll_('comments').filter(function (c) { return c.id; })
    .map(function (c) { delete c._row; return c; });
  return { events: events, files: files, comments: comments, version: apiVersion() };
}

function apiSaveEvent(input) {
  if (!input || !String(input.judul || '').trim()) throw new Error('Judul kegiatan wajib diisi');
  if (!input.mulai) throw new Error('Tanggal mulai wajib diisi');
  return withLock_(function () {
    const sh = sheet_('events');
    const user = me_();
    const t = now_();
    const clean = {
      judul: String(input.judul).trim().slice(0, 200),
      deskripsi: String(input.deskripsi || '').slice(0, 5000),
      mulai: input.mulai,
      selesai: input.selesai && input.selesai >= input.mulai ? input.selesai : input.mulai,
      jamMulai: input.seharian ? '' : (input.jamMulai || ''),
      jamSelesai: input.seharian ? '' : (input.jamSelesai || ''),
      seharian: !!input.seharian,
      lokasi: String(input.lokasi || '').slice(0, 300),
      kategori: input.kategori || 'Umum',
      prioritas: input.prioritas || 'Sedang',
      status: input.status || 'Direncanakan',
      peserta: input.peserta || [],
      checklist: input.checklist || [],
      tautan: input.tautan || [],
    };

    if (input.id) {
      const cur = readAll_('events').filter(function (e) { return e.id === input.id && e.dihapus !== 'TRUE'; })[0];
      if (!cur) throw new Error('Kegiatan tidak ditemukan (mungkin sudah dihapus)');
      const before = parseEvent_(cur);
      const diff = {};
      Object.keys(clean).forEach(function (k) {
        if (JSON.stringify(before[k]) !== JSON.stringify(clean[k])) diff[k] = { dari: before[k], ke: clean[k] };
      });
      const rec = Object.assign({}, before, clean, { diubahOleh: user, diubahPada: t, dihapus: false });
      sh.getRange(cur._row, 1, 1, SHEETS.events.length).setValues([toRow_('events', rec)]);
      log_('UBAH', rec, JSON.stringify(diff));
      bump_();
      return rec;
    }

    const rec = Object.assign({ id: uid_() }, clean,
      { dibuatOleh: user, dibuatPada: t, diubahOleh: user, diubahPada: t, dihapus: false });
    sh.appendRow(toRow_('events', rec));
    log_('BUAT', rec, JSON.stringify(clean));
    bump_();
    return rec;
  });
}

/** Pindah tanggal cepat (drag & drop). */
function apiMoveEvent(id, mulai) {
  return withLock_(function () {
    const cur = readAll_('events').filter(function (e) { return e.id === id && e.dihapus !== 'TRUE'; })[0];
    if (!cur) throw new Error('Kegiatan tidak ditemukan');
    const ev = parseEvent_(cur);
    const span = (new Date(ev.selesai) - new Date(ev.mulai)) / 864e5;
    const s = new Date(mulai + 'T00:00:00Z');
    s.setUTCDate(s.getUTCDate() + span);
    const selesai = s.toISOString().slice(0, 10);
    const rec = Object.assign({}, ev, { mulai: mulai, selesai: selesai, diubahOleh: me_(), diubahPada: now_() });
    sheet_('events').getRange(cur._row, 1, 1, SHEETS.events.length).setValues([toRow_('events', rec)]);
    log_('PINDAH', rec, JSON.stringify({ mulai: { dari: ev.mulai, ke: mulai } }));
    bump_();
    return rec;
  });
}

function apiDeleteEvent(id) {
  return withLock_(function () {
    const cur = readAll_('events').filter(function (e) { return e.id === id && e.dihapus !== 'TRUE'; })[0];
    if (!cur) return true;
    const ev = parseEvent_(cur);
    // soft-delete: data tetap tersimpan untuk audit & bisa dipulihkan
    sheet_('events').getRange(cur._row, SHEETS.events.indexOf('dihapus') + 1).setValue(true);
    log_('HAPUS', ev, '');
    bump_();
    return true;
  });
}

function apiRestoreEvent(id) {
  return withLock_(function () {
    const cur = readAll_('events').filter(function (e) { return e.id === id; })[0];
    if (!cur) throw new Error('Kegiatan tidak ditemukan');
    sheet_('events').getRange(cur._row, SHEETS.events.indexOf('dihapus') + 1).setValue(false);
    log_('PULIHKAN', parseEvent_(cur), '');
    bump_();
    return true;
  });
}

function apiDuplicateEvent(id, mulai) {
  const cur = readAll_('events').filter(function (e) { return e.id === id; })[0];
  if (!cur) throw new Error('Kegiatan tidak ditemukan');
  const ev = parseEvent_(cur);
  const span = (new Date(ev.selesai) - new Date(ev.mulai)) / 864e5;
  const s = new Date(mulai + 'T00:00:00Z');
  s.setUTCDate(s.getUTCDate() + span);
  return apiSaveEvent(Object.assign({}, ev, {
    id: '', mulai: mulai, selesai: s.toISOString().slice(0, 10), status: 'Direncanakan',
    checklist: (ev.checklist || []).map(function (c) { return { t: c.t, d: false }; }),
  }));
}

function apiToggleChecklist(id, index) {
  return withLock_(function () {
    const cur = readAll_('events').filter(function (e) { return e.id === id && e.dihapus !== 'TRUE'; })[0];
    if (!cur) throw new Error('Kegiatan tidak ditemukan');
    const ev = parseEvent_(cur);
    if (!ev.checklist[index]) return ev;
    ev.checklist[index].d = !ev.checklist[index].d;
    ev.diubahOleh = me_(); ev.diubahPada = now_();
    sheet_('events').getRange(cur._row, 1, 1, SHEETS.events.length).setValues([toRow_('events', ev)]);
    log_('CHECKLIST', ev, (ev.checklist[index].d ? '☑ ' : '☐ ') + ev.checklist[index].t);
    bump_();
    return ev;
  });
}

function apiUpload(eventId, name, mime, base64) {
  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > MAX_UPLOAD_MB * 1024 * 1024) throw new Error('Ukuran file maks ' + MAX_UPLOAD_MB + ' MB');
  const ev = readAll_('events').filter(function (e) { return e.id === eventId; })[0];
  if (!ev) throw new Error('Simpan kegiatan terlebih dahulu sebelum mengunggah');

  // Folder: Lampiran / 2026-09 / 2026-09-27 — Judul
  const root = DriveApp.getFolderById(PROP.getProperty('FOLDER_ID'));
  const month = getOrCreate_(root, ev.mulai.slice(0, 7));
  const folder = getOrCreate_(month, ev.mulai + ' — ' + ev.judul.replace(/[\\/]/g, '-').slice(0, 80));
  const file = folder.createFile(Utilities.newBlob(bytes, mime || 'application/octet-stream', name));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* kebijakan domain */ }
  file.setDescription('Lampiran "' + ev.judul + '" oleh ' + me_());

  return withLock_(function () {
    const rec = {
      id: uid_(), eventId: eventId, fileId: file.getId(), nama: name, mime: mime,
      ukuran: bytes.length, url: file.getUrl(), oleh: me_(), pada: now_(), dihapus: false,
    };
    sheet_('files').appendRow(toRow_('files', rec));
    log_('UNGGAH', { id: eventId, judul: ev.judul }, name + ' (' + Math.round(bytes.length / 1024) + ' KB)');
    bump_();
    return rec;
  });
}

function apiDeleteFile(id) {
  return withLock_(function () {
    const f = readAll_('files').filter(function (x) { return x.id === id; })[0];
    if (!f) return true;
    sheet_('files').getRange(f._row, SHEETS.files.indexOf('dihapus') + 1).setValue(true);
    try { DriveApp.getFileById(f.fileId).setTrashed(true); } catch (e) { /* tidak punya akses */ }
    log_('HAPUS_FILE', { id: f.eventId, judul: '' }, f.nama);
    bump_();
    return true;
  });
}

function apiComment(eventId, isi) {
  isi = String(isi || '').trim().slice(0, 2000);
  if (!isi) throw new Error('Komentar kosong');
  return withLock_(function () {
    const rec = { id: uid_(), eventId: eventId, oleh: me_(), pada: now_(), isi: isi };
    sheet_('comments').appendRow(toRow_('comments', rec));
    log_('KOMENTAR', { id: eventId, judul: '' }, isi.slice(0, 200));
    bump_();
    return rec;
  });
}

function apiLogs(limit, eventId) {
  let rows = readAll_('logs');
  if (eventId) rows = rows.filter(function (r) { return r.eventId === eventId; });
  return rows.slice(-(limit || 300)).reverse().map(function (r) { delete r._row; return r; });
}

function getOrCreate_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------------------------------------------------------------- AI: dokumen yang dibutuhkan */

/**
 * Menghasilkan daftar dokumen yang perlu disiapkan untuk sebuah kegiatan.
 * Memakai Google Gemini bila Script Property GEMINI_API_KEY diisi,
 * jika tidak memakai template bawaan per kategori.
 */
function apiAiDocs(eventId) {
  const cur = readAll_('events').filter(function (e) { return e.id === eventId; })[0];
  if (!cur) throw new Error('Kegiatan tidak ditemukan');
  const ev = parseEvent_(cur);
  let docs = null, sumber = 'template', contoh = [], galat = '';
  const ckey = PROP.getProperty('ANTHROPIC_API_KEY');
  if (ckey) {
    try { const r = claudeDocs_(ev, ckey); docs = r.docs; contoh = r.contoh; sumber = 'claude'; } catch (e) { galat = String(e.message || e).slice(0, 300); Logger.log('Claude gagal: ' + e); }
  }
  const gkey = PROP.getProperty('GEMINI_API_KEY');
  if ((!docs || !docs.length) && gkey) {
    try { docs = geminiDocs_(ev, gkey); sumber = 'gemini'; } catch (e) { Logger.log('Gemini gagal: ' + e); }
  }
  // tanpa AI: frontend memakai template format BHP Medan (lihat bhpDocs di Index.html)
  if (!docs || !docs.length) return { sumber: 'template', docs: null, galat: galat || (ckey ? '' : 'ANTHROPIC_API_KEY belum diisi di Properti skrip') };
  log_('AI_DOKUMEN', ev, sumber + ': ' + docs.map(function (d) { return d.nama; }).join(', '));
  return { sumber: sumber, docs: docs, contoh: contoh };
}

/* ---------------------------------------------------------------- AI Dokumen dengan Claude
 * Script Property: ANTHROPIC_API_KEY (wajib), CLAUDE_MODEL (opsional, default claude-opus-5-5),
 * CLAUDE_EFFORT (opsional: low/medium/high, default low = cepat & hemat kredit),
 * CLAUDE_FAST (opsional: 0 untuk mematikan mode cepat; default aktif),
 * CONTOH_FOLDER_ID (opsional; default folder "Contoh Dokumen" di folder utama aplikasi).
 * Contoh dokumen dibaca dari Drive: Google Docs & teks (sebagai teks), PDF (dibaca langsung oleh Claude). */
const ATURAN_DOKUMEN_BHP = [
  'ATURAN JENIS SURAT DI BHP MEDAN (WAJIB DIIKUTI):',
  '1. Rapat/pertemuan INTERNAL (semua peserta pegawai BHP Medan dan diadakan di kantor BHP Medan atau daring khusus pegawai) memakai NOTA DINAS, bukan Surat Undangan.',
  '2. SURAT UNDANGAN hanya bila: (a) rapat/kegiatan diadakan di luar kantor BHP Medan dan BHP yang mengundang, atau (b) BHP mengundang orang/pihak luar ke BHP atau ke rapat daring BHP (mis. keluarga, wali/pengampu, ahli waris, kuasa hukum, kreditor/debitor, instansi lain).',
  '3. Pegawai BHP yang berangkat ke luar kantor (pengadilan, Kanwil, pemda, lokasi harta, dll.) memerlukan SURAT TUGAS (dan SPPD/bukti kehadiran perjalanan dinas bila ada perjalanan).',
  '4. Jangan menyarankan dokumen yang tidak relevan. Utamakan dokumen yang memang lazim dipakai BHP Medan.',
  '5. Bila diberi DOKUMEN TERKAIT dari Drive: (a) surat sejenis (nota dinas, undangan, surat tugas, dll.) dipakai sebagai contoh format, tiru struktur, gaya bahasa, format nomor, kop, dan penutupnya; (b) dokumen tentang kegiatan yang sama (mis. TOR, susunan panitia, rundown, paparan) dipakai sebagai sumber fakta (nama kegiatan, tanggal, narasumber, susunan acara) untuk mengisi draf. Jangan menyalin data orang/perkara dari kasus lain. Pada alasan, sebutkan berkas Drive yang dipakai.',
].join('\n');

/* Mencari dokumen relevan di SELURUH Drive pengguna (aplikasi berjalan sebagai pengguna yang mengakses),
 * ditambah folder "Contoh Dokumen" bila ada. Kata kunci diambil dari judul & keterangan kegiatan
 * (mis. "webinar", "pengampuan") serta jenis surat yang mungkin dipakai (nota dinas, undangan, ...).
 * Yang dibaca isinya: Google Docs & teks, serta 1 PDF kecil. File lain (Word/Slides) hanya disebut namanya. */
const KATA_UMUM_ = ['rapat', 'internal', 'terkait', 'kegiatan', 'panitia', 'teknis', 'tentang', 'dalam', 'untuk', 'dengan', 'pada',
  'yang', 'hari', 'tanggal', 'pukul', 'acara', 'medan', 'balai', 'harta', 'peninggalan', 'kantor', 'lanjutan', 'tahun', 'bulan'];
function kataKunci_(ev) {
  const seen = {};
  return (ev.judul + ' ' + ev.deskripsi).toLowerCase().split(/[^a-z0-9]+/)
    .filter(function (w) { if (w.length < 5 || KATA_UMUM_.indexOf(w) >= 0 || seen[w]) return false; seen[w] = 1; return true; })
    .slice(0, 5);
}
function contohDokumen_(ev) {
  const files = [], ids = {};
  const tambah = function (f) { if (f && !ids[f.getId()] && files.length < 60) { ids[f.getId()] = 1; files.push(f); } };
  // 1) folder Contoh Dokumen (opsional)
  try {
    const id = PROP.getProperty('CONTOH_FOLDER_ID');
    const folder = id ? DriveApp.getFolderById(id) : getOrCreate_(DriveApp.getFolderById(PROP.getProperty('ROOT_ID')), 'Contoh Dokumen');
    const it = folder.getFiles(); while (it.hasNext()) tambah(it.next());
  } catch (e) { /* tidak ada folder contoh */ }
  // 2) pencarian di seluruh Drive
  const topik = kataKunci_(ev);
  const jenis = ['nota dinas', 'undangan', 'surat tugas', 'notulen', 'laporan', 'daftar hadir', 'kerangka acuan', 'TOR'];
  const mime = "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/pdf' or " +
    "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/vnd.google-apps.presentation')";
  const q = function (s) { return s.replace(/'/g, "\\'"); };
  const cari = function (query, maks) {
    try { const it = DriveApp.searchFiles(query + ' and trashed = false and ' + mime); let n = 0; while (it.hasNext() && n++ < maks) tambah(it.next()); }
    catch (e) { Logger.log('Cari Drive gagal: ' + e); }
  };
  if (topik.length) {
    cari('(' + topik.map(function (w) { return "title contains '" + q(w) + "'"; }).join(' or ') + ')', 25);
    cari('(' + topik.map(function (w) { return "fullText contains '" + q(w) + "'"; }).join(' or ') + ')', 15);
  }
  cari('(' + jenis.map(function (w) { return "title contains '" + q(w) + "'"; }).join(' or ') + ')', 15);
  if (!files.length) return { baca: [], nama: [] };
  // urutkan: paling banyak kata topik di nama file, lalu jenis surat, lalu yang terbaru
  const skor = function (f) {
    const n = f.getName().toLowerCase();
    return topik.reduce(function (s, w) { return s + (n.indexOf(w) >= 0 ? 3 : 0); }, 0) +
      jenis.reduce(function (s, w) { return s + (n.indexOf(w.toLowerCase()) >= 0 ? 2 : 0); }, 0) +
      (Date.now() - f.getLastUpdated().getTime() < 180 * 864e5 ? 1 : 0);
  };
  files.sort(function (a, b) { return skor(b) - skor(a); });
  const baca = []; let pdf = 0;
  files.slice(0, 15).forEach(function (f) {
    if (baca.length >= 4) return;
    const m = f.getMimeType(), nama = f.getName();
    try {
      if (m === MimeType.GOOGLE_DOCS) baca.push({ nama: nama, teks: DocumentApp.openById(f.getId()).getBody().getText().slice(0, 3500) });
      else if (m === MimeType.PDF && pdf < 1 && f.getSize() < 2 * 1024 * 1024) { pdf++; baca.push({ nama: nama, pdf: Utilities.base64Encode(f.getBlob().getBytes()) }); }
    } catch (e) { Logger.log('Dilewati ' + nama + ': ' + e); }
  });
  const dibaca = baca.map(function (b) { return b.nama; });
  return { baca: baca, nama: files.slice(0, 20).map(function (f) { return f.getName(); }).filter(function (n) { return dibaca.indexOf(n) < 0; }) };
}

function claudeDocs_(ev, key) {
  const hasil = contohDokumen_(ev), contoh = hasil.baca;
  const content = [];
  contoh.forEach(function (c) {
    content.push({ type: 'text', text: 'DOKUMEN TERKAIT dari Drive BHP Medan: "' + c.nama + '"' });
    if (c.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: c.pdf }, title: c.nama });
    else content.push({ type: 'text', text: c.teks });
  });
  if (hasil.nama.length) content.push({ type: 'text', text: 'Berkas lain di Drive yang namanya relevan (isi tidak dibaca): ' + hasil.nama.join('; ') });
  content.push({ type: 'text', text: 'Tentukan 3-5 dokumen terpenting yang perlu disiapkan (sebelum, saat, dan sesudah) untuk kegiatan berikut, ' +
    'lalu buat draf isi ringkas tetapi siap pakai untuk tiap dokumen (cukup kerangka utama, tanpa pengulangan) dalam bahasa Indonesia formal sesuai format BHP Medan. Isi data kegiatan yang diketahui, ' +
    'gunakan [....] untuk yang harus dilengkapi. Pada "alasan", sebutkan singkat kenapa dokumen itu yang dipakai (mis. kenapa Nota Dinas, bukan Undangan).\n\n' +
    'GAYA ISI: Agenda/acara cukup SINGKAT dan umum (satu kalimat, atau paling banyak 2-3 poin pendek), jangan merinci tugas tiap seksi atau anggaran. ' +
    'Perhatikan TANGGAL HARI INI dan jarak ke kegiatan utama (mis. tanggal webinar/acara pokok yang disebut di berkas Drive): bila rapat ini diadakan ' +
    'beberapa hari sebelum kegiatan utama, sebut acaranya sebagai rapat persiapan (mis. "Rapat persiapan pelaksanaan Webinar ... tanggal ..."), ' +
    'bukan pembahasan rinci.\n\nTanggal hari ini: ' + Utilities.formatDate(new Date(), 'Asia/Jakarta', 'EEEE, d MMMM yyyy') + ' (' +
    Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd') + ').\n\nKegiatan: ' +
    JSON.stringify({
      judul: ev.judul, deskripsi: ev.deskripsi, tanggal: ev.mulai + (ev.selesai !== ev.mulai ? ' s/d ' + ev.selesai : ''),
      jam: ev.seharian ? 'seharian' : ev.jamMulai + '-' + ev.jamSelesai, lokasi: ev.lokasi, kategori: ev.kategori,
      peserta: ev.peserta, checklist: ev.checklist.map(function (c) { return c.t; }),
    }) });
  const system = 'Kamu asisten administrasi Balai Harta Peninggalan (BHP) Medan, Kantor Wilayah Kementerian Hukum Sumatera Utara ' +
    '(tugas: wali pengawas perwalian/pengampuan, penyumpahan wali, inventarisasi harta, kepailitan, harta tak terurus). ' +
    'Format surat dinas BHP Medan: kop "KEMENTERIAN HUKUM REPUBLIK INDONESIA / KANTOR WILAYAH SUMATERA UTARA / BALAI HARTA PENINGGALAN MEDAN / ' +
    'Jalan Listrik No. 10 Medan", nomor "W.2.AHU.AHU.1-<kode>-[....]", Sifat/Lampiran/Hal, "Yth. ...", penutup "Demikian ...", ' +
    'tanda tangan "Kepala," lalu nama Kepala BHP Medan: ' + (PROP.getProperty('KEPALA_NAMA') || 'Syafriadi Lubis') + ' (WAJIB ditulis lengkap, jangan [....]), dan Tembusan bila perlu. ' +
    'Data tetap kantor (nama instansi, alamat, nama Kepala) selalu diisi, jangan diganti [....]; [....] hanya untuk data yang benar-benar belum diketahui seperti nomor surat. JANGAN tulis kop surat di draf (kop dengan logo dibuat otomatis); mulai isi dari judul/nomor surat.\n\n' + ATURAN_DOKUMEN_BHP;
  const schema = { type: 'object', additionalProperties: false, required: ['docs'], properties: { docs: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['nama', 'tahap', 'alasan', 'isi'],
    properties: { nama: { type: 'string' }, tahap: { type: 'string', enum: ['Sebelum', 'Saat', 'Sesudah'] }, alasan: { type: 'string' }, isi: { type: 'string' } } } } } };
  // Mode cepat (speed: "fast") membuat jawaban keluar jauh lebih cepat; bila ditolak (mis. batas pemakaian),
  // otomatis diulang dengan kecepatan standar. Matikan dengan Script Property CLAUDE_FAST = 0.
  const kirim = function (cepat) {
    const body = {
      model: PROP.getProperty('CLAUDE_MODEL') || 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: PROP.getProperty('CLAUDE_EFFORT') || 'low', format: { type: 'json_schema', schema: schema } },
      system: system,
      messages: [{ role: 'user', content: content }],
    };
    if (cepat) body.speed = 'fast';
    return UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      payload: JSON.stringify(body),
    });
  };
  const cepat = PROP.getProperty('CLAUDE_FAST') !== '0';
  let res = kirim(cepat);
  if (cepat && res.getResponseCode() !== 200 && res.getResponseCode() !== 401) res = kirim(false);
  if (res.getResponseCode() !== 200) throw new Error('Claude ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal') throw new Error('Claude menolak permintaan ini');
  if (msg.stop_reason === 'max_tokens') throw new Error('Jawaban Claude terpotong (max_tokens)');
  const text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  const docs = (JSON.parse(text).docs || []).filter(function (d) { return d && d.nama; }).slice(0, 8);
  return { docs: docs, contoh: contoh.map(function (c) { return c.nama; }) };
}

function geminiDocs_(ev, key) {
  const model = PROP.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const prompt = 'Kamu asisten administrasi Balai Harta Peninggalan (BHP) Medan, Kantor Wilayah Kementerian Hukum Sumatera Utara ' +
    '(tugas: wali pengawas perwalian/pengampuan, penyumpahan wali, inventarisasi harta, kepailitan, harta tak terurus). ' +
    'Ikuti format surat dinas BHP Medan: kop "KEMENTERIAN HUKUM REPUBLIK INDONESIA / KANTOR WILAYAH SUMATERA UTARA / ' +
    'BALAI HARTA PENINGGALAN MEDAN / Jalan Listrik No. 10 Medan", nomor "W.2.AHU.AHU.1-<kode>-[....]", Sifat/Lampiran/Hal, ' +
    '"Yth. ...", penutup "Demikian ...", tanda tangan "Kepala," lalu nama, dan Tembusan bila perlu. Laporan memakai bab ' +
    'Pendahuluan (Umum, Maksud dan Tujuan, Ruang Lingkup, Tempat dan Waktu, Pegawai Yang Ditunjuk, Dasar Hukum), ' +
    'Kegiatan yang Dilaksanakan dan Hasil yang Dicapai, Kesimpulan dan Saran, Penutup. ' +
    ATURAN_DOKUMEN_BHP + ' ' +
    'Kamu asisten administrasi kantor pemerintahan Indonesia. Untuk kegiatan berikut, tentukan 3-7 dokumen ' +
    'yang WAJIB/PERLU disiapkan (sebelum, saat, dan sesudah kegiatan). Untuk tiap dokumen beri: nama, tahap ' +
    '(Sebelum/Saat/Sesudah), alasan singkat, dan draf isi (kerangka lengkap dengan poin-poin, bahasa Indonesia formal, ' +
    'isi data kegiatan yang diketahui, gunakan [....] untuk yang harus dilengkapi). Jawab HANYA JSON array ' +
    '[{"nama":"","tahap":"","alasan":"","isi":""}].\n\nKegiatan: ' + JSON.stringify({
      judul: ev.judul, deskripsi: ev.deskripsi, tanggal: ev.mulai + (ev.selesai !== ev.mulai ? ' s/d ' + ev.selesai : ''),
      jam: ev.seharian ? 'seharian' : ev.jamMulai + '-' + ev.jamSelesai, lokasi: ev.lokasi, kategori: ev.kategori,
      peserta: ev.peserta, checklist: ev.checklist.map(function (c) { return c.t; }),
    });
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
  });
  if (res.getResponseCode() !== 200) throw new Error(res.getContentText().slice(0, 300));
  const text = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  const arr = JSON.parse(text.replace(/^```json|```$/g, ''));
  return arr.filter(function (d) { return d && d.nama; }).slice(0, 8);
}

/** Membuat draf Google Docs di folder kegiatan dan mencatatnya sebagai lampiran.
 *  Kop surat dibuat rapi seperti surat resmi BHP Medan: logo Pengayoman di kiri, teks kop rata tengah
 *  (instansi tebal, alamat kecil), lalu garis pemisah. logoB64 = PNG logo (base64) dari tampilan. */
const KOP_BHP_ = [
  { t: 'KEMENTERIAN HUKUM REPUBLIK INDONESIA', b: true, s: 12 },
  { t: 'KANTOR WILAYAH SUMATERA UTARA', b: true, s: 12 },
  { t: 'BALAI HARTA PENINGGALAN MEDAN', b: true, s: 14 },
  { t: 'Jalan Listrik No. 10 Medan', s: 9 },
  { t: 'Telepon: (061) 451 7830, Faksimile: (061) 451 4328', s: 9 },
  { t: 'Laman: www.bhpmedan.kemenkum.go.id, Pos-el: bhp.medan@kemenkum.go.id', s: 9 },
];
function buangKopTeks_(lines) {
  // draf AI/template biasanya diawali kop berupa teks; dibuang karena diganti kop rapi
  let i = 0;
  const kopRe = /^(kementerian hukum|kantor wilayah|balai harta peninggalan|jalan listrik|jl\.? listrik|telepon|laman|pos-el|_{5,}|-{5,}|={5,})/i;
  while (i < lines.length && i < 10 && (kopRe.test(lines[i].trim()) || (!lines[i].trim() && i < 7))) i++;
  const out = i > 0 ? lines.slice(i) : lines.slice();
  while (out.length > 1 && !out[0].trim()) out.shift();
  return out;
}
function apiCreateDoc(eventId, nama, isi, logoB64) {
  const ev = readAll_('events').filter(function (e) { return e.id === eventId; })[0];
  if (!ev) throw new Error('Kegiatan tidak ditemukan');
  const doc = DocumentApp.create(nama + ' — ' + ev.judul);
  const body = doc.getBody();
  // Catatan: sebagian setter DocumentApp (mis. Paragraph.setText) tidak mengembalikan objek,
  // jadi setiap pemanggilan ditulis terpisah (tanpa chaining) agar tidak error "null".
  body.setMarginTop(36); body.setMarginBottom(56); body.setMarginLeft(72); body.setMarginRight(56); // pt (A4, kiri 2,54 cm)
  const font = function (el, size, bold) { el.setFontFamily('Arial'); el.setFontSize(size); el.setBold(!!bold); return el; };
  const rapat = function (p, align) { if (align) p.setAlignment(align); p.setSpacingBefore(0); p.setSpacingAfter(0); };

  // ---- kop: tabel 2 kolom tanpa garis (logo | teks)
  const tbl = body.insertTable(0, [['', '']]);
  tbl.setBorderWidth(0);
  tbl.setColumnWidth(0, 78);
  const cLogo = tbl.getCell(0, 0), cTeks = tbl.getCell(0, 1);
  cLogo.setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER); cLogo.setPaddingLeft(0); cLogo.setPaddingRight(4);
  cTeks.setVerticalAlignment(DocumentApp.VerticalAlignment.CENTER);
  if (logoB64) {
    try {
      const pLogo = cLogo.getChild(0).asParagraph();
      const img = pLogo.appendInlineImage(Utilities.newBlob(Utilities.base64Decode(logoB64), 'image/png', 'logo.png'));
      const r = img.getHeight() / img.getWidth(); img.setWidth(68); img.setHeight(Math.round(68 * r));
      pLogo.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    } catch (e) { Logger.log('Logo gagal: ' + e); }
  }
  KOP_BHP_.forEach(function (k, i) {
    const p = i === 0 ? cTeks.getChild(0).asParagraph() : cTeks.appendParagraph(k.t);
    if (i === 0) p.setText(k.t);
    rapat(p, DocumentApp.HorizontalAlignment.CENTER); p.setLineSpacing(1);
    font(p, k.s, k.b);
  });
  const garis = body.insertParagraph(1, '');
  garis.appendHorizontalRule();
  garis.setSpacingBefore(2); garis.setSpacingAfter(6);

  // ---- isi surat
  const lines = buangKopTeks_(String(isi || '').split('\n'));
  let first = true;
  lines.forEach(function (line) {
    let p;
    if (first) { const ps = body.getParagraphs(); p = ps[ps.length - 1]; p.setText(line); first = false; }
    else p = body.appendParagraph(line);
    p.setHeading(DocumentApp.ParagraphHeading.NORMAL); rapat(p); p.setLineSpacing(1.15);
    font(p, 12, false);
    const s = line.trim();
    // judul surat (mis. NOTA DINAS, SURAT TUGAS, NOTULEN) & nomornya: rata tengah, judul tebal
    if (s && s.length <= 70 && s === s.toUpperCase() && /[A-Z]/.test(s) && !/[:|]/.test(s)) { p.setAlignment(DocumentApp.HorizontalAlignment.CENTER); font(p, 12, true); }
    else if (/^NOMOR\b|^Nomor\s*:?\s*W\.2/i.test(s) && s.length < 70 && !/\t/.test(line)) p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    else p.setAlignment(DocumentApp.HorizontalAlignment.JUSTIFY);
  });
  doc.saveAndClose();

  const file = DriveApp.getFileById(doc.getId());
  const root = DriveApp.getFolderById(PROP.getProperty('FOLDER_ID'));
  file.moveTo(getOrCreate_(getOrCreate_(root, ev.mulai.slice(0, 7)), ev.mulai + ' — ' + ev.judul.replace(/[\\/]/g, '-').slice(0, 80)));
  return withLock_(function () {
    const rec = { id: uid_(), eventId: eventId, fileId: doc.getId(), nama: file.getName(), mime: 'application/vnd.google-apps.document',
      ukuran: 0, url: doc.getUrl(), oleh: me_(), pada: now_(), dihapus: false };
    sheet_('files').appendRow(toRow_('files', rec));
    log_('BUAT_DOKUMEN', { id: eventId, judul: ev.judul }, file.getName());
    bump_();
    return rec;
  });
}

/** Menambahkan item ke checklist (dipakai AI & To Do List). */
function apiAddChecklist(eventId, items) {
  return withLock_(function () {
    const cur = readAll_('events').filter(function (e) { return e.id === eventId && e.dihapus !== 'TRUE'; })[0];
    if (!cur) throw new Error('Kegiatan tidak ditemukan');
    const ev = parseEvent_(cur);
    const have = ev.checklist.map(function (c) { return c.t; });
    [].concat(items).forEach(function (t) { t = String(t).trim(); if (t && have.indexOf(t) < 0) ev.checklist.push({ t: t, d: false }); });
    ev.diubahOleh = me_(); ev.diubahPada = now_();
    sheet_('events').getRange(cur._row, 1, 1, SHEETS.events.length).setValues([toRow_('events', ev)]);
    log_('CHECKLIST', ev, '+ ' + [].concat(items).join(', '));
    bump_();
    return ev;
  });
}
