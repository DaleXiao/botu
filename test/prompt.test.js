// test/prompt.test.js — SPEC-431 A4：ICON_PROMPT 与原站 full prompt 逐字一致（md5 锚定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ICON_PROMPT } from '../functions/api/generate.js';

const FULL_PROMPT_MD5 = 'a90f21f3b840d5ff21e41a93f1efe53e'; // /tmp/gis/prompt-full-ko.txt, 3193 chars

test('ICON_PROMPT md5 == 原站 full prompt', () => {
  const md5 = createHash('md5').update(ICON_PROMPT, 'utf8').digest('hex');
  assert.equal(md5, FULL_PROMPT_MD5);
});

test('ICON_PROMPT 结构锚点：长度 3193，[목표] 开头，含冲突处理优先级', () => {
  assert.equal(ICON_PROMPT.length, 3193);
  assert.ok(ICON_PROMPT.startsWith('[목표]'));
  assert.match(ICON_PROMPT, /\[충돌 처리\]/);
  assert.match(ICON_PROMPT, /검은 캡슐 눈/);
});
