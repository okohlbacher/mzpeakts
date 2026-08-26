// Regression guard for the RemoteBlob read-serialization contract. parquet-wasm's async
// reader issues several page reads concurrently through RemoteBlob; when the underlying
// range fetches COMPLETE out of issue order (browsers reorder network completions; Node's
// local fetch happens to stay in order) the wasm reader's buffer assembly corrupts and it
// panics with `range start must not be greater than end` while parsing a page — observed
// on a Shimadzu native dual-facet file the moment the centroid facet was read a second
// time. RemoteBlob therefore chains every read on the shared source so completion order
// always equals issue order. This test drives a source whose FIRST read is slow and
// asserts the fast second read still completes after it. No WASM/fixture needed.
import { expect, test } from "vitest";
import { RemoteBlob } from "../src/store";
import type * as zip from "@zip.js/zip.js";

function makeSlowFirstSource(completionLog: string[]) {
  let call = 0;
  return {
    // Only readUint8Array is exercised by RemoteBlob reads.
    readUint8Array: async (offset: number, length: number): Promise<Uint8Array> => {
      const id = `r${call++}@${offset}+${length}`;
      // First read resolves LATE (next macrotask ticks), later reads would resolve
      // immediately if they were allowed to run concurrently.
      const delay = call === 1 ? 30 : 0;
      await new Promise((r) => setTimeout(r, delay));
      completionLog.push(id);
      return new Uint8Array(length).fill(call);
    },
  } as unknown as zip.Reader<unknown>;
}

test("reads on one shared source complete in issue order even when the first is slow", async () => {
  const log: string[] = [];
  const source = makeSlowFirstSource(log);
  const blob = new RemoteBlob(source, "member.parquet", 0, 10_000);

  const first = blob.slice(0, 6000).bytes(); // slow
  const second = blob.slice(6000, 6200).bytes(); // fast — must still finish second

  const [a, b] = await Promise.all([first, second]);
  expect(log).toEqual(["r0@0+6000", "r1@6000+200"]); // completion order == issue order
  expect(a.length).toBe(6000);
  expect(b.length).toBe(200);
});

test("a failed read does not wedge the chain — the next read still runs", async () => {
  const log: string[] = [];
  let call = 0;
  const source = {
    readUint8Array: async (offset: number, length: number): Promise<Uint8Array> => {
      call++;
      if (call === 1) throw new Error("boom");
      log.push(`ok@${offset}`);
      return new Uint8Array(length);
    },
  } as unknown as zip.Reader<unknown>;
  const blob = new RemoteBlob(source, "member.parquet", 0, 1000);

  await expect(blob.slice(0, 10).bytes()).rejects.toThrow("boom");
  const next = await blob.slice(10, 20).bytes();
  expect(next.length).toBe(10);
  expect(log).toEqual(["ok@10"]);
});
