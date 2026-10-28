'use strict';
// Reading what is inside files: type sniffing, media/document metadata, the
// inspect pass after a scan, and the filters, groups and layout tokens built on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { inspectFile, sniff, mismatch, exifDate, iso6709 } = require('../../src/engine/inspect');
const { parseMdls } = require('../../src/engine/fileinfo');
const { renderTarget, checkTemplate } = require('../../src/engine/template');
const { makeEngine } = require('../helpers/engine');
const { tmpdir, write } = require('../helpers/fsutil');

const FX = path.join(__dirname, '..', 'fixtures', 'media');
const ext = (f) => (f.includes('.') ? f.split('.').pop() : '');
const info = (f) => inspectFile(path.join(FX, f), { ext: ext(f) });

test('photo EXIF: date taken with time zone, camera, GPS, orientation, exposure', async () => {
  const r = await info('photo.jpg');
  assert.equal(r.type, 'jpeg');
  assert.equal(r.mismatch, false);
  assert.equal(r.taken, Date.UTC(2021, 6, 14, 16, 22, 5)); // 18:22:05 at +02:00
  assert.equal(r.camera, 'Canon EOS R6');
  assert.deepEqual([r.width, r.height], [64, 48]);
  assert.deepEqual([r.gpsLat, r.gpsLon], [48.141667, -11.57]);
  assert.equal(r.extra.orientation, 6);
  assert.equal(r.extra.exposure, '1/250');
  assert.equal(r.extra.fnumber, 'f/2.8');
  assert.equal(r.extra.iso, 400);
});

test('image sizes for PNG, WebP, GIF and a portrait JPEG', async () => {
  for (const [f, type, w, h] of [['screenshot.png', 'png', 64, 48], ['anim.webp', 'webp', 64, 48], ['icon.gif', 'gif', 64, 48], ['portrait.jpg', 'jpeg', 30, 60]]) {
    const r = await info(f);
    assert.equal(r.type, type, f);
    assert.deepEqual([r.width, r.height], [w, h], f);
    assert.equal(r.taken, null, f);
  }
});

test('content wins over the extension: a JPEG named .png is flagged', async () => {
  const r = await info('really-a-jpeg.png');
  assert.equal(r.type, 'jpeg');
  assert.equal(r.mismatch, true);
  // Interchangeable containers and unknown extensions are not mismatches.
  assert.equal(mismatch('mov', 'mp4'), false);
  assert.equal(mismatch('mp4', 'm4v'), false);
  assert.equal(mismatch('zip', 'docx'), false);
  assert.equal(mismatch('jpeg', 'weird'), false);
  assert.equal(mismatch('jpeg', ''), false);
  assert.equal(mismatch('heic', 'jpg'), true);
  assert.equal(mismatch('pdf', 'docx'), true);
});

test('video: duration, size, codec, creation date, iPhone camera and location', async () => {
  const mp4 = await info('clip.mp4');
  assert.equal(mp4.type, 'mp4');
  assert.equal(mp4.family, 'video');
  assert.equal(mp4.duration, 1);
  assert.deepEqual([mp4.width, mp4.height], [64, 48]);
  assert.equal(mp4.taken, Date.UTC(2020, 4, 1, 10, 0, 0));
  assert.equal(mp4.title, 'Clip');
  const mov = await info('clip.mov');
  assert.equal(mov.type, 'mov');
  assert.equal(mov.camera, 'Apple iPhone 15 Pro');
  assert.equal(mov.taken, Date.UTC(2023, 7, 1, 10, 30, 0));
  assert.deepEqual([mov.gpsLat, mov.gpsLon], [48.1371, 11.5754]);
  assert.equal(mov.extra.codec, 'avc1');
});

test('audio: ID3, FLAC and MP4 tags, durations', async () => {
  const mp3 = await info('song.mp3');
  assert.deepEqual([mp3.type, mp3.artist, mp3.album, mp3.title, mp3.extra.year], ['mp3', 'Nils Frahm', 'Spaces', 'Says', 2013]);
  assert.ok(Math.abs(mp3.duration - 1) < 0.1, String(mp3.duration));
  assert.ok(mp3.bitrate > 16000 && mp3.bitrate < 64000, String(mp3.bitrate));
  const flac = await info('track.flac');
  assert.deepEqual([flac.type, flac.artist, flac.album, flac.title, flac.duration], ['flac', 'Nils', 'Live', 'Intro', 1.5]);
  const wav = await info('sound.wav');
  assert.deepEqual([wav.type, wav.duration], ['wav', 0.5]);
  const m4a = await info('voice.m4a');
  assert.deepEqual([m4a.type, m4a.family, m4a.artist, m4a.album, m4a.duration], ['m4a', 'audio', 'X', 'Y', 1]);
});

test('documents: PDF pages, Office properties, zip, text', async () => {
  assert.equal((await info('doc.pdf')).pages, 1);
  assert.equal((await info('two.pdf')).pages, 2);
  const d = await info('report.docx');
  assert.deepEqual([d.type, d.family, d.title, d.author, d.pages, d.extra.words], ['docx', 'document', 'Quarterly & Report', 'Tim B', 7, 1234]);
  assert.equal(d.created, Date.UTC(2022, 2, 4, 5, 6, 7));
  assert.equal((await info('plain.zip')).type, 'zip');
  const t = await info('notes.txt');
  assert.deepEqual([t.type, t.extra.lines], ['text', 3]);
  assert.equal((await info('page.txt')).type, 'html');
  assert.equal((await info('empty.dat')).type, 'empty');
});

// A minimal HEIF file as an iPhone writes it: ftyp, meta with an Exif item
// located by iloc, and the image size in ispe.
function makeHeic() {
  const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
  const full = (type, v, ...parts) => box(type, Buffer.from([v, 0, 0, 0]), ...parts);
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  // Exif payload: 4-byte offset to the TIFF header, then a big-endian TIFF.
  const tiff = Buffer.alloc(200);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8); // IFD0: Model, ExifIFD
  const ent = (o, tag, type, count, val) => { tiff.writeUInt16BE(tag, o); tiff.writeUInt16BE(type, o + 2); tiff.writeUInt32BE(count, o + 4); tiff.writeUInt32BE(val, o + 8); };
  ent(10, 0x0110, 2, 14, 100); tiff.write('iPhone 15 Pro\0', 100, 'latin1');
  ent(22, 0x8769, 4, 1, 50);
  tiff.writeUInt16BE(1, 50); ent(52, 0x9003, 2, 20, 130); tiff.write('2024:02:29 08:15:00\0', 130, 'latin1');
  const exif = Buffer.concat([u32(6), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const ftyp = box('ftyp', Buffer.from('heic', 'latin1'), u32(0), Buffer.from('mif1heic', 'latin1'));
  const infe = full('infe', 2, u16(7), u16(0), Buffer.from('Exif', 'latin1'), Buffer.from([0]));
  const iinf = full('iinf', 0, u16(1), infe);
  const ispe = full('ispe', 0, u32(4032), u32(3024));
  const iprp = box('iprp', box('ipco', ispe));
  const ilocFor = (off) => full('iloc', 0, Buffer.from([0x44, 0x00]), u16(1), u16(7), u16(0), u16(1), u32(off), u32(exif.length));
  const metaWith = (off) => full('meta', 0, full('hdlr', 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)), iinf, ilocFor(off), iprp);
  const head = Buffer.concat([ftyp, metaWith(0)]);
  const off = head.length + 8; // mdat header
  return Buffer.concat([ftyp, metaWith(off), box('mdat', exif)]);
}

test('HEIC: real size from ispe, Exif found through iloc', async () => {
  const dir = tmpdir('dm-heic-');
  const f = path.join(dir, 'IMG_0001.HEIC');
  fs.writeFileSync(f, makeHeic());
  const r = await inspectFile(f, { ext: 'heic' });
  assert.equal(r.type, 'heic');
  assert.deepEqual([r.width, r.height], [4032, 3024]);
  assert.equal(r.camera, 'iPhone 15 Pro');
  assert.equal(r.taken, new Date(2024, 1, 29, 8, 15, 0).getTime());
  // The classic iPhone trap: HEIC data under a .jpg name.
  assert.equal((await inspectFile(f, { ext: 'jpg' })).mismatch, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hostile input: truncated and random files never throw or hang', async () => {
  const dir = tmpdir('dm-fuzz-');
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sources = fs.readdirSync(FX).map((f) => fs.readFileSync(path.join(FX, f))).concat([makeHeic()]);
  let n = 0;
  for (const src of sources) {
    for (let k = 0; k < 25; k++) {
      const b = Buffer.from(src.subarray(0, Math.max(1, Math.floor(rnd() * src.length))));
      // Flip bytes, often in the header where the offsets live.
      for (let i = 0; i < 8; i++) { const at = Math.floor(rnd() * Math.min(b.length, i < 4 ? 256 : b.length)); b[at] = Math.floor(rnd() * 256); }
      const f = path.join(dir, `f${n++}.bin`);
      fs.writeFileSync(f, b);
      const r = await inspectFile(f, { ext: 'bin' });
      assert.ok(r && typeof r === 'object');
      if (r.width !== null) assert.ok(r.width > 0 && r.width <= 1e6);
      if (r.duration !== null) assert.ok(r.duration >= 0 && r.duration <= 1e7);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('helpers: sniffing, EXIF dates, ISO 6709 and Spotlight output', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7\n'), 9), 'pdf');
  assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), 6), 'zip');
  assert.equal(sniff(Buffer.from('SQLite format 3\0'), 100), 'sqlite');
  assert.equal(sniff(Buffer.from([0, 1, 2, 0, 0xff]), 5), null);
  assert.equal(sniff(Buffer.from('Grüße\n'), 8), 'text');
  assert.equal(exifDate('0000:00:00 00:00:00'), null);
  assert.equal(exifDate('2020:01:02 03:04:05', '-05:00'), Date.UTC(2020, 0, 2, 8, 4, 5));
  assert.deepEqual(iso6709('+35.6762+139.6503+040.000/'), { lat: 35.6762, lon: 139.6503 });
  assert.equal(iso6709('+00.0000+000.0000/'), null);
  const out = ['2024-01-05 10:00:00 +0000', '(\n    Work,\n    "Red\n6"\n)', '(\n    "https://example.com/file.zip",\n    "https://example.com/"\n)',
    '(null)', '(null)', '(null)'].join('\0');
  const md = parseMdls(out, ['a', 'b']);
  assert.equal(md[0].last_used, Date.UTC(2024, 0, 5, 10));
  assert.equal(md[0].tags, 'Work, Red');
  assert.equal(md[0].where_from, 'https://example.com/file.zip');
  assert.deepEqual(md[1], { last_used: null, tags: null, where_from: null });
});

test('layout tokens from content: date taken, camera, artist, real extension, shape', () => {
  assert.deepEqual(checkTemplate('{taken_yyyy}/{camera}/{stem}.{realext}'), []);
  const e = { rel_path: 'x/IMG_1.png', parent: 'x', name: 'IMG_1.png', ext: 'png', category: 'image', size: 10, mtime: Date.UTC(2010, 0, 1, 12),
    ftype: 'jpeg', taken: new Date(2021, 6, 14, 18).getTime(), camera: 'Canon EOS R6', width: 30, height: 60 };
  assert.equal(renderTarget('{taken_yyyy}/{taken_date}/{camera}/{shape}/{stem}.{realext}', e), '2021/2021-07-14/Canon EOS R6/portrait/IMG_1.jpg');
  // No date taken: falls back to the modified date; no camera: a named folder.
  assert.equal(renderTarget('{taken_yyyy}/{camera}/{name}', { ...e, taken: null, camera: null }), '2010/unknown camera/IMG_1.png');
  assert.equal(renderTarget('{artist}/{album}/{name}', { ...e, artist: 'AC/DC', album: null }, { target: 'exfat' }), 'AC-DC/unknown album/IMG_1.png');
});

test('scan reads file details; filters, groups, overview, issues and CSV use them; rescans only re-read changed files', async (t) => {
  const ctx = makeEngine();
  t.after(ctx.cleanup);
  const e = ctx.engine;
  const root = path.join(ctx.dir, 'lib');
  for (const f of ['photo.jpg', 'really-a-jpeg.png', 'clip.mov', 'song.mp3', 'track.flac', 'report.docx', 'notes.txt']) write(root, `in/${f}`, fs.readFileSync(path.join(FX, f)));
  write(root, 'in/IMG_0001.jpg', makeHeic());
  const src = e.sourcesAdd({ path: root });
  const job = await ctx.waitJob(e.scanStart({ sourceId: src.id }));
  assert.equal(job.result.inspect.done, 8);
  assert.equal(job.result.inspect.mismatched, 2);
  const q = (filter, opts = {}) => e.entriesQuery({ filter: { sourceId: src.id, ...filter }, limit: 100, ...opts });
  const names = (r) => r.rows.map((x) => x.name).sort();

  assert.deepEqual(names(q({ mismatch: true })), ['IMG_0001.jpg', 'really-a-jpeg.png']);
  assert.deepEqual(names(q({ camera: 'canon' })), ['photo.jpg']);
  assert.deepEqual(names(q({ gps: 'yes' })), ['clip.mov', 'photo.jpg']);
  assert.deepEqual(names(q({ artist: 'Nils' })), ['song.mp3', 'track.flac']);
  assert.deepEqual(names(q({ ftypes: ['jpeg'] })), ['photo.jpg', 'really-a-jpeg.png']);
  assert.deepEqual(names(q({ taken: 'no' })), ['really-a-jpeg.png']);
  assert.deepEqual(names(q({ durationMin: 1.2 })), ['track.flac']);
  assert.deepEqual(names(q({ pixelsMin: 1e7 })), ['IMG_0001.jpg']);
  const row = q({ name: 'photo.jpg' }).rows[0];
  assert.equal(row.camera, 'Canon EOS R6');
  assert.equal(row.ftype, 'jpeg');
  assert.deepEqual(q({ kinds: ['file'] }, { sort: 'taken', dir: 'desc' }).rows.slice(0, 3).map((x) => x.name), ['IMG_0001.jpg', 'clip.mov', 'photo.jpg']);

  const cams = e.entriesGroup({ filter: { sourceId: src.id, kinds: ['file'] }, dim: 'camera' });
  assert.deepEqual(cams.filter((g) => g.key !== '(none)').map((g) => g.key).sort(), ['Apple iPhone 15 Pro', 'Canon EOS R6', 'iPhone 15 Pro']);
  assert.ok(e.entriesGroup({ filter: { sourceId: src.id }, dim: 'takenYear' }).some((g) => g.key === '2024'));

  const ov = e.overview({ sourceId: src.id });
  assert.equal(ov.content.inspected, 8);
  assert.equal(ov.content.mismatched, 2);
  assert.equal(ov.content.withGps, 2);
  assert.ok(ov.cameras.some((c) => c.key === 'Canon EOS R6'));
  assert.ok(ov.realTypes.some((x) => x.key === 'heic'));
  assert.equal(ov.issues.find((i) => i.key === 'type-mismatch').count, 2);

  const one = e.entryInfo({ entryId: row.id });
  assert.equal(one.info.camera, 'Canon EOS R6');
  assert.equal(one.info.extra.iso, 400);
  assert.equal(one.abs, path.join(root, 'in/photo.jpg'));

  // Lay out photos by date taken: the planned paths use the content date.
  e.wsStage({ sourceId: src.id, op: 'layout', params: { template: 'Photos/{taken_yyyy}/{stem}.{realext}' }, selection: { filter: { ftypes: ['jpeg', 'heic'] } } });
  const planned = Object.fromEntries(e.wsDiff({ sourceId: src.id, kind: 'all', limit: 100 }).rows.map((r) => [r.name, r.vpath]));
  assert.equal(planned['photo.jpg'], 'Photos/2021/photo.jpg');
  assert.equal(planned['really-a-jpeg.png'], `Photos/${new Date(fs.statSync(path.join(root, 'in/really-a-jpeg.png')).mtimeMs).getFullYear()}/really-a-jpeg.jpg`);
  assert.equal(planned['IMG_0001.jpg'], 'Photos/2024/IMG_0001.heic');

  const csv = e.exportCsv ? await e.exportCsv({ filter: { sourceId: src.id, kinds: ['file'] }, file: path.join(ctx.dir, 'out.csv') }) : null;
  if (csv) {
    const text = fs.readFileSync(csv.file, 'utf8');
    assert.match(text.split('\n')[0], /real_type,extension_mismatch,taken/);
    assert.match(text, /Canon EOS R6/);
  }

  // Rescan: unchanged files keep their details and are not read again.
  const before = ctx.engine.db.prepare('SELECT rel_path, inspected_at FROM fileinfo').all();
  fs.appendFileSync(path.join(root, 'in/notes.txt'), 'line4\n');
  const again = await ctx.waitJob(e.scanStart({ sourceId: src.id }));
  assert.equal(again.result.inspect.done, 1);
  const after = Object.fromEntries(ctx.engine.db.prepare('SELECT rel_path, inspected_at FROM fileinfo').all().map((r) => [r.rel_path, r.inspected_at]));
  for (const b of before) if (b.rel_path !== 'in/notes.txt') assert.equal(after[b.rel_path], b.inspected_at);
  // Deleted files lose their details.
  fs.rmSync(path.join(root, 'in/song.mp3'));
  await ctx.waitJob(e.scanStart({ sourceId: src.id }));
  assert.equal(ctx.engine.db.prepare("SELECT COUNT(*) AS n FROM fileinfo WHERE rel_path = 'in/song.mp3'").get().n, 0);
});

test('previews: small images as-is, text as text, refuses changed files and links', async () => {
  const { makePreview } = require('../../src/preview');
  const dir = tmpdir('dm-prev-');
  const mk = (name, data, info) => {
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, data);
    const st = fs.statSync(abs);
    return { abs, kind: 'file', size: st.size, mtime: Math.floor(st.mtimeMs), name, info };
  };
  const img = mk('a.jpg', fs.readFileSync(path.join(FX, 'photo.jpg')), { type: 'jpeg', family: 'image' });
  const p = await makePreview(img);
  assert.equal(p.kind, 'image');
  assert.ok(p.src.startsWith('data:image/jpeg;base64,'));
  const txt = mk('n.txt', 'hello\n'.repeat(5000), { type: 'text', family: 'text' });
  const t = await makePreview(txt);
  assert.equal(t.kind, 'text');
  assert.equal(t.truncated, true);
  assert.ok(t.text.length <= 6 * 1024);
  fs.appendFileSync(txt.abs, 'more');
  assert.equal((await makePreview(txt)).stale, true);
  fs.symlinkSync(img.abs, path.join(dir, 'link.jpg'));
  assert.equal((await makePreview({ ...img, abs: path.join(dir, 'link.jpg') })).kind, 'none');
  assert.equal((await makePreview({ ...img, abs: path.join(dir, 'gone.jpg') })).kind, 'none');
  assert.equal((await makePreview({ ...img, kind: 'dir' })).kind, 'none');
  fs.rmSync(dir, { recursive: true, force: true });
});
