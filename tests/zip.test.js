'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inflateRawSync } = require('node:zlib');
const { crc32, zip } = require('../scripts/zip');

test('the zero-dependency ZIP writer preserves file names, content, CRC, and directory offsets', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const entries = [['manifest.json', '{"name":"test"}'], ['src/日本語.js', 'const text = "hello";\n']];
  const archive = zip(entries);
  let offset = 0;
  for (const [filename, text] of entries) {
    assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    const size = archive.readUInt32LE(offset + 18);
    const length = archive.readUInt16LE(offset + 26);
    const name = archive.subarray(offset + 30, offset + 30 + length).toString('utf8');
    assert.equal(name, filename);
    const content = inflateRawSync(archive.subarray(offset + 30 + length, offset + 30 + length + size));
    assert.equal(content.toString(), text);
    assert.equal(crc32(content), archive.readUInt32LE(offset + 14));
    offset += 30 + length + size;
  }
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt32LE(end + 16), offset);
  assert.equal(archive.readUInt16LE(end + 10), entries.length);
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
});
