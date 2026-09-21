// Tests for Eater address splitting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "../dist/eater/address.js";

test("full observed form: street, borough, state name, ZIP, country", () => {
  assert.deepEqual(parseAddress("226 7th Avenue, Brooklyn, New York 11215, United States"), {
    address_line1: "226 7th Avenue",
    locality: "Brooklyn",
    region: "NY",
    postal_code: "11215",
  });
});

test("state-code + ZIP form", () => {
  assert.deepEqual(parseAddress("2135 Broadway, New York, NY 10023, USA"), {
    address_line1: "2135 Broadway",
    locality: "New York",
    region: "NY",
    postal_code: "10023",
  });
});

test("ZIP split from state by a comma", () => {
  assert.deepEqual(parseAddress("123 E 149th St, Bronx, NY, 10455"), {
    address_line1: "123 E 149th St",
    locality: "Bronx",
    region: "NY",
    postal_code: "10455",
  });
});

test("bare state code, no ZIP", () => {
  assert.deepEqual(parseAddress("1 Main St, Austin, TX"), {
    address_line1: "1 Main St",
    locality: "Austin",
    region: "TX",
    postal_code: null,
  });
});

test("ZIP+4", () => {
  const r = parseAddress("1 Main St, New York, NY 10001-1234");
  assert.equal(r.postal_code, "10001-1234");
  assert.equal(r.region, "NY");
});

test("unparseable tail keeps the full string, invents nothing", () => {
  assert.deepEqual(parseAddress("Somewhere, London, UK"), {
    address_line1: "Somewhere, London, UK",
    locality: null,
    region: null,
    postal_code: null,
  });
});

test("null and empty input", () => {
  assert.deepEqual(parseAddress(null), {
    address_line1: null,
    locality: null,
    region: null,
    postal_code: null,
  });
  assert.deepEqual(parseAddress("   "), {
    address_line1: null,
    locality: null,
    region: null,
    postal_code: null,
  });
});

test("single segment keeps the whole string", () => {
  const r = parseAddress("No commas here");
  assert.equal(r.address_line1, "No commas here");
  assert.equal(r.region, null);
});
