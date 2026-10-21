import { describe, expect, it } from "vitest";
import { appendAccount, withoutAccount } from "../src/edit.js";

const cur = JSON.stringify({
  version: 1,
  accounts: [
    { id: "gmail", default: true },
    { id: "crazycaracal" },
    { id: "kontakt" },
  ],
});
const ids = (j: string) => (JSON.parse(j).accounts as { id: string }[]).map((a) => a.id);

describe("appendAccount", () => {
  it("keeps all existing mailboxes", () => {
    expect(ids(appendAccount(cur, { id: "info-sendarodigital" }))).toEqual(["gmail", "crazycaracal", "kontakt", "info-sendarodigital"]);
  });
  it("replaces a mailbox with the same id instead of doubling it", () => {
    expect(ids(appendAccount(cur, { id: "kontakt", label: "neu" }))).toEqual(["gmail", "crazycaracal", "kontakt"]);
  });
  it("starts a list when nothing is stored", () => {
    expect(ids(appendAccount(undefined, { id: "a" }))).toEqual(["a"]);
  });
});

describe("withoutAccount", () => {
  it("removes exactly one mailbox", () => {
    expect(ids(withoutAccount(cur, "crazycaracal"))).toEqual(["gmail", "kontakt"]);
  });
  it("refuses the default mailbox", () => {
    expect(() => withoutAccount(cur, "gmail")).toThrow(/Standard/);
  });
  it("refuses an unknown id", () => {
    expect(() => withoutAccount(cur, "gibtsnicht")).toThrow(/nicht gespeichert/);
  });
  it("refuses to remove the last mailbox", () => {
    expect(() => withoutAccount(JSON.stringify({ version: 1, accounts: [{ id: "x" }] }), "x")).toThrow(/letzte/);
  });
});
