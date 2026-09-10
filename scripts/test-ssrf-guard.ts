import assert from "node:assert/strict";
import {
  validateUrlForFetch,
  sanitizeHtmlToText,
} from "../lib/workspace/ssrf-guard";

console.log("=== RUNNING SSRF GUARD TESTS ===");

// 1. Loopback and Localhost IP blocking
console.log("--- 1. Loopback and Localhost Blocking ---");
assert.equal(validateUrlForFetch("http://127.0.0.1:3000").valid, false, "127.0.0.1 is blocked");
assert.equal(validateUrlForFetch("http://localhost:8080").valid, false, "localhost is blocked");
assert.equal(validateUrlForFetch("http://[::1]:5000").valid, false, "IPv6 loopback [::1] is blocked");
assert.equal(validateUrlForFetch("http://0.0.0.0").valid, false, "0.0.0.0 is blocked");
console.log("[PASS] Localhost and loopback IPs are blocked.");

// 2. Cloud Metadata IP blocking
console.log("--- 2. Cloud Metadata Endpoint Blocking ---");
assert.equal(validateUrlForFetch("http://169.254.169.254/latest/meta-data/").valid, false, "169.254.169.254 is blocked");
assert.equal(validateUrlForFetch("http://169.254.170.2/v2/credentials/").valid, false, "169.254.170.2 is blocked");
assert.equal(validateUrlForFetch("http://metadata.google.internal/computeMetadata/v1/").valid, false, "metadata.google.internal is blocked");
console.log("[PASS] Cloud metadata endpoints are blocked.");

// 3. Private IP ranges (RFC 1918 & RFC 6598)
console.log("--- 3. Private IP Ranges ---");
assert.equal(validateUrlForFetch("http://10.0.0.5/api").valid, false, "10.0.0.0/8 is blocked");
assert.equal(validateUrlForFetch("http://172.16.0.1").valid, false, "172.16.0.0/12 is blocked");
assert.equal(validateUrlForFetch("http://192.168.1.1").valid, false, "192.168.0.0/16 is blocked");
assert.equal(validateUrlForFetch("http://100.64.0.1").valid, false, "100.64.0.0/10 is blocked");
console.log("[PASS] Private IP ranges are blocked.");

// 4. Scheme validation
console.log("--- 4. Scheme Validation ---");
assert.equal(validateUrlForFetch("file:///etc/passwd").valid, false, "file: scheme is blocked");
assert.equal(validateUrlForFetch("gopher://evil.com/").valid, false, "gopher: scheme is blocked");
assert.equal(validateUrlForFetch("ftp://ftp.is.co.za/").valid, false, "ftp: scheme is blocked");
assert.equal(validateUrlForFetch("data:text/plain;base64,SGVsbG8=").valid, false, "data: scheme is blocked");
console.log("[PASS] Non-HTTP(S) schemes are blocked.");

// 5. Valid public URLs allowed
console.log("--- 5. Valid Public URLs ---");
assert.equal(validateUrlForFetch("https://example.com").valid, true, "example.com is valid");
assert.equal(validateUrlForFetch("https://api.github.com/repos").valid, true, "api.github.com is valid");
assert.equal(validateUrlForFetch("http://info.cern.ch").valid, true, "info.cern.ch is valid");
console.log("[PASS] Valid public internet URLs are accepted.");

// 6. HTML text sanitization
console.log("--- 6. HTML Sanitization ---");
const rawHtml = "<html><head><script>alert(1)</script><style>body{color:red}</style></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>";
const sanitized = sanitizeHtmlToText(rawHtml);
assert.equal(sanitized.includes("<script>"), false, "Script tags stripped");
assert.equal(sanitized.includes("<style>"), false, "Style tags stripped");
assert.equal(sanitized.includes("Title"), true, "Title preserved");
assert.equal(sanitized.includes("Hello & welcome"), true, "Entities decoded");
console.log("[PASS] HTML text sanitization verified.");

console.log("=== ALL SSRF GUARD TESTS PASSED ===");
