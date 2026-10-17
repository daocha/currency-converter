// Safe arithmetic for the amount fields: + − × ÷, parentheses, unary minus and
// thousands separators ("1,200×3"). A small recursive-descent parser; never uses eval.
(function (root) {
  "use strict";

  const OPS = {
    "+": "+",
    "-": "-", "−": "-", "–": "-",
    "*": "*", "×": "*", "x": "*", "X": "*",
    "/": "/", "÷": "/",
  };
  const NUMBER = /^(\d[\d,]*(\.\d*)?|\.\d+)/;

  function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      const num = NUMBER.exec(text.slice(i));
      if (num) {
        tokens.push({ type: "num", value: parseFloat(num[0].replace(/,/g, "")) });
        i += num[0].length;
      } else if (ch in OPS) {
        tokens.push({ type: "op", value: OPS[ch] });
        i++;
      } else if (ch === "(" || ch === ")") {
        tokens.push({ type: ch });
        i++;
      } else {
        return null; // unsupported character
      }
    }
    return tokens;
  }

  // expr   := term (("+" | "-") term)*
  // term   := factor (("*" | "/") factor)*
  // factor := ("+" | "-") factor | number | "(" expr ")"
  function parse(tokens) {
    let pos = 0;
    const isOp = (...ops) => tokens[pos] && tokens[pos].type === "op" && ops.includes(tokens[pos].value);

    function expr() {
      let value = term();
      while (isOp("+", "-")) {
        const op = tokens[pos++].value;
        const rhs = term();
        value = op === "+" ? value + rhs : value - rhs;
      }
      return value;
    }

    function term() {
      let value = factor();
      while (isOp("*", "/")) {
        const op = tokens[pos++].value;
        const rhs = factor();
        value = op === "*" ? value * rhs : value / rhs;
      }
      return value;
    }

    function factor() {
      const tok = tokens[pos++];
      if (!tok) throw new SyntaxError("unexpected end");
      if (tok.type === "num") return tok.value;
      if (tok.type === "op" && (tok.value === "+" || tok.value === "-")) {
        const value = factor();
        return tok.value === "-" ? -value : value;
      }
      if (tok.type === "(") {
        const value = expr();
        if (!tokens[pos] || tokens[pos].type !== ")") throw new SyntaxError("missing )");
        pos++;
        return value;
      }
      throw new SyntaxError("unexpected token");
    }

    const value = expr();
    if (pos !== tokens.length) throw new SyntaxError("unexpected trailing input");
    return value;
  }

  function run(tokens) {
    try {
      const value = parse(tokens);
      return Number.isFinite(value) ? value : null; // e.g. division by zero
    } catch {
      return null;
    }
  }

  /** Value of a complete expression, or null if it is empty or invalid. */
  function evaluate(text) {
    const tokens = tokenize(text);
    return tokens && tokens.length ? run(tokens) : null;
  }

  /** Like evaluate(), but tolerates input still being typed: "100+" -> 100, "(2+3" -> 5. */
  function evaluatePartial(text) {
    const tokens = tokenize(text);
    if (!tokens) return null;
    while (tokens.length && ["op", "("].includes(tokens[tokens.length - 1].type)) tokens.pop();
    if (!tokens.length) return null;
    let depth = 0;
    for (const t of tokens) depth += t.type === "(" ? 1 : t.type === ")" ? -1 : 0;
    while (depth-- > 0) tokens.push({ type: ")" });
    return run(tokens);
  }

  /** True when the text is a calculation rather than a plain (possibly negative) number. */
  function isExpression(text) {
    return /\d\s*[-+−–*×xX/÷]|[()]/.test(text);
  }

  const api = { evaluate, evaluatePartial, isExpression };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof self !== "undefined" ? self : this);
