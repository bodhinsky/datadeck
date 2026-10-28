'use strict';
// File categories by extension. Used for statistics, filters and the
// {category} token in restructure templates.
const MAP = {
  image: 'jpg jpeg png gif bmp tif tiff webp heic heif avif svg ico raw cr2 cr3 nef arw dng orf rw2 raf psd psb xcf',
  video: 'mp4 m4v mov avi mkv wmv flv webm mpg mpeg 3gp mts m2ts vob ogv',
  audio: 'mp3 m4a aac wav aiff aif flac alac ogg oga opus wma mid midi',
  document: 'pdf doc docx odt rtf txt md markdown pages tex epub mobi azw3 djvu',
  spreadsheet: 'xls xlsx xlsm ods csv tsv numbers',
  presentation: 'ppt pptx odp key',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst dmg iso',
  code: 'js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh zsh bash pl lua r m scala sql html htm css scss vue',
  data: 'json xml yaml yml toml ini cfg plist db sqlite sqlite3 parquet avro log',
  font: 'ttf otf woff woff2',
  executable: 'app exe msi pkg deb rpm apk bin',
  email: 'eml msg mbox emlx',
};

const BY_EXT = new Map();
for (const [cat, list] of Object.entries(MAP)) for (const e of list.split(' ')) BY_EXT.set(e, cat);

const CATEGORIES = [...Object.keys(MAP), 'other'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function categoryOf(ext, kind = 'file') {
  if (kind === 'dir') return 'folder';
  if (kind === 'symlink') return 'link';
  return BY_EXT.get(ext) || 'other';
}

module.exports = { CATEGORIES, extOf, categoryOf };
