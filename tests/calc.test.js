// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, evaluatePartial, isExpression } = require("../static/calc.js");

test("plain numbers, including thousands separators", () => {
  assert.equal(evaluate("100"), 100);
  assert.equal(evaluate("1,234.5"), 1234.5);
  assert.equal(evaluate(".5"), 0.5);
  assert.equal(evaluate("-20"), -20);
});

test("operators, precedence and parentheses", () => {
  assert.equal(evaluate("100+50×2"), 200);
  assert.equal(evaluate("(100+50)×2"), 300);
  assert.equal(evaluate("90÷3−10"), 20);
  assert.equal(evaluate("2*3/4"), 1.5);
  assert.equal(evaluate("1,200 x 3"), 3600);
  assert.equal(evaluate("-(2+3)*-2"), 10);
});

test("invalid input yields null", () => {
  assert.equal(evaluate(""), null);
  assert.equal(evaluate("abc"), null);
  assert.equal(evaluate("5÷0"), null);
  assert.equal(evaluate("2+"), null);
  assert.equal(evaluate("(2+3"), null);
  assert.equal(evaluate("2)"), null);
  assert.equal(evaluate("alert(1)"), null);
});

test("partial input while typing", () => {
  assert.equal(evaluatePartial("100+"), 100);
  assert.equal(evaluatePartial("100×("), 100);
  assert.equal(evaluatePartial("(2+3"), 5);
  assert.equal(evaluatePartial("10×(2+3"), 50);
  assert.equal(evaluatePartial("+"), null);
  assert.equal(evaluatePartial(""), null);
});

test("isExpression distinguishes calculations from numbers", () => {
  assert.equal(isExpression("1,234.50"), false);
  assert.equal(isExpression("-5"), false);
  assert.equal(isExpression("5-2"), true);
  assert.equal(isExpression("100×"), true);
  assert.equal(isExpression("(5"), true);
});
