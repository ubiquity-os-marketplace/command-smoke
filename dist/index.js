'use strict';

const fs = require('fs');
const zlib = require('zlib');

function normalizeCommand(command) {
  return String(command || '')
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase();
}

function extractCommandName(raw) {
  if (raw == null) return '';

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return '';

    const parsed = tryJsonParse(text);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object' && typeof parsed.value.name === 'string') {
      return normalizeCommand(parsed.value.name);
    }

    return normalizeCommand(text);
  }

  if (typeof raw === 'object' && typeof raw.name === 'string') {
    return normalizeCommand(raw.name);
  }

  return normalizeCommand(String(raw));
}

function tryJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function decompressBase64(buffer) {
  const attempts = [
    { name: 'brotli', fn: zlib.brotliDecompressSync },
    { name: 'gzip', fn: zlib.gunzipSync },
    { name: 'deflate', fn: zlib.inflateSync },
    { name: 'deflate-raw', fn: zlib.inflateRawSync },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      return attempt.fn(buffer);
    } catch (error) {
      errors.push(`${attempt.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Unable to decompress input (tried ${attempts.map((a) => a.name).join(', ')}): ${errors.join(' | ')}`
  );
}

function parsePossiblyCompressedJson(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing or empty ${label}`);
  }

  const direct = tryJsonParse(value);
  if (direct.ok) return direct.value;

  let decompressed;
  try {
    decompressed = decompressBase64(Buffer.from(value, 'base64')).toString('utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} as JSON or base64+compressed JSON: ${message}`);
  }

  const afterDecompress = tryJsonParse(decompressed);
  if (afterDecompress.ok) return afterDecompress.value;

  throw new Error(`Failed to parse ${label} after decompression as JSON: ${afterDecompress.error}`);
}

async function postIssueComment({ owner, repo, issueNumber, body, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ubiquity-os-marketplace/command-smoke',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw new Error(
      `Failed to create comment: ${response.status} ${response.statusText}${responseText ? `\n${responseText}` : ''}`
    );
  }

  return response.json();
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set');
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const inputs = event.inputs || {};

  const authToken = inputs.authToken;
  if (!authToken) {
    throw new Error('Missing inputs.authToken');
  }

  const payload = parsePossiblyCompressedJson(inputs.eventPayload, 'inputs.eventPayload');
  const normalizedCommand = extractCommandName(inputs.command);
  const commentBody = String(payload?.comment?.body || '');

  const isSmoke = normalizedCommand === 'smoke' || /(^|\s)\/smoke(\s|$)/i.test(commentBody);

  if (!isSmoke) {
    console.log('Not a /smoke invocation; exiting.');
    return;
  }

  const fullName = payload?.repository?.full_name;
  const owner = payload?.repository?.owner?.login || (typeof fullName === 'string' ? fullName.split('/')[0] : undefined);
  const repo = payload?.repository?.name || (typeof fullName === 'string' ? fullName.split('/')[1] : undefined);
  const issueNumber = payload?.issue?.number;
  const triggeringCommentId = payload?.comment?.id;

  if (!owner || !repo || !issueNumber || !triggeringCommentId) {
    throw new Error('Could not resolve repository owner/name/issue number/comment id from event payload');
  }

  const responseBody = ['smoke ok', `repo: ${owner}/${repo}`, `issue: ${issueNumber}`, `comment: ${triggeringCommentId}`].join(
    '\n'
  );

  await postIssueComment({ owner, repo, issueNumber, body: responseBody, token: authToken });
  console.log(`Replied with smoke ok on ${owner}/${repo}#${issueNumber} (trigger comment id: ${triggeringCommentId})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
