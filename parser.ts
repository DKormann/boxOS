const KEYWORDS = new Set([
  "break", "const", "continue", "else", "false", "for", "function", "if",
  "let", "null", "return", "throw", "true", "typeof", "while",
]);

const FORBIDDEN_PROPERTIES = new Set([
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
  "__proto__", "arguments", "callee", "caller", "constructor", "eval", "prototype",
]);

// Some JavaScript reserved words are not grammar keywords in this small language.
// Keep them available as fixed property names (for example, ctx.delete), but never
// permit them as user-controlled bindings.
const FORBIDDEN_BINDING_NAMES = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "eval", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "arguments",
]);

type TokenKind = "identifier" | "number" | "string" | "keyword" | "punctuator" | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  offset: number;
  line: number;
  column: number;
};

export class ProcSyntaxError extends SyntaxError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, token: Pick<Token, "offset" | "line" | "column">) {
    super(`${message} (${token.line}:${token.column})`);
    this.name = "ProcSyntaxError";
    this.offset = token.offset;
    this.line = token.line;
    this.column = token.column;
  }
}

class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly source: string) {}

  next(): Token {
    this.skipTrivia();
    const start = this.location();
    const char = this.peek();

    if (char === "") return { kind: "eof", value: "", ...start };

    if (isIdentifierStart(char)) {
      let value = this.take();
      while (isIdentifierPart(this.peek())) value += this.take();
      return { kind: KEYWORDS.has(value) ? "keyword" : "identifier", value, ...start };
    }

    if (isDigit(char)) {
      let value = this.take();
      while (isDigit(this.peek())) value += this.take();
      if (this.peek() === ".") {
        value += this.take();
        if (!isDigit(this.peek())) this.fail("Expected a digit after the decimal point", start);
        while (isDigit(this.peek())) value += this.take();
      }
      if (this.peek() === "e" || this.peek() === "E") {
        value += this.take();
        if (this.peek() === "+" || this.peek() === "-") value += this.take();
        if (!isDigit(this.peek())) this.fail("Expected an exponent", start);
        while (isDigit(this.peek())) value += this.take();
      }
      return { kind: "number", value, ...start };
    }

    if (char === "'" || char === '"') {
      const quote = this.take();
      let value = "";
      while (this.peek() !== quote) {
        if (this.peek() === "" || this.peek() === "\n" || this.peek() === "\r") {
          this.fail("Unterminated string literal", start);
        }
        const part = this.take();
        if (part === "\\") {
          const escaped = this.take();
          if (!"'\"\\bfnrtv0".includes(escaped)) {
            this.fail("Only simple string escapes are allowed", start);
          }
          value += part + escaped;
        } else {
          value += part;
        }
      }
      this.take();
      return { kind: "string", value, ...start };
    }

    const three = this.source.slice(this.offset, this.offset + 3);
    if (["===", "!=="].includes(three)) {
      this.take(); this.take(); this.take();
      return { kind: "punctuator", value: three, ...start };
    }

    const two = this.source.slice(this.offset, this.offset + 2);
    if (["&&", "||", "<=", ">=", "++", "--", "+=", "-=", "*=", "/=", "%="].includes(two)) {
      this.take(); this.take();
      return { kind: "punctuator", value: two, ...start };
    }

    if ("{}()[];,.:?+-*/%!<>=\n".includes(char)) {
      this.take();
      return { kind: "punctuator", value: char, ...start };
    }

    this.fail(`Character ${JSON.stringify(char)} is not allowed`, start);
  }

  private skipTrivia(): void {
    for (;;) {
      while (/\s/.test(this.peek())) this.take();
      if (this.peek() === "/" && this.peek(1) === "/") {
        while (this.peek() !== "" && this.peek() !== "\n") this.take();
        continue;
      }
      if (this.peek() === "/" && this.peek(1) === "*") {
        const start = this.location();
        this.take(); this.take();
        while (!(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === "") this.fail("Unterminated block comment", start);
          this.take();
        }
        this.take(); this.take();
        continue;
      }
      return;
    }
  }

  private peek(ahead = 0): string {
    return this.source[this.offset + ahead] ?? "";
  }

  private take(): string {
    const char = this.peek();
    if (char === "") return char;
    this.offset++;
    if (char === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private location(): Pick<Token, "offset" | "line" | "column"> {
    return { offset: this.offset, line: this.line, column: this.column };
  }

  private fail(message: string, location: Pick<Token, "offset" | "line" | "column">): never {
    throw new ProcSyntaxError(message, location);
  }
}

type Expression = { assignable: boolean; numericLiteral: boolean };
const VALUE: Expression = { assignable: false, numericLiteral: false };

class Parser {
  private current: Token;
  private previous: Token;
  private readonly scopes: Set<string>[];
  private loopDepth = 0;

  constructor(source: string, argumentNames: readonly string[]) {
    const root = new Set<string>();
    for (const name of argumentNames) {
      if (!isIdentifierName(name) || FORBIDDEN_BINDING_NAMES.has(name)) {
        throw new TypeError(`Invalid procedure argument name: ${JSON.stringify(name)}`);
      }
      if (root.has(name)) throw new TypeError(`Duplicate procedure argument: ${name}`);
      root.add(name);
    }
    this.scopes = [root];
    const lexer = new Lexer(source);
    this.nextToken = () => lexer.next();
    this.current = this.nextToken();
    this.previous = this.current;
  }

  private readonly nextToken: () => Token;

  parse(): void {
    while (this.current.kind !== "eof") this.statement();
  }

  private statement(): void {
    if (this.match(";")) return;
    if (this.at("{")) return this.block();
    if (this.matchKeyword("let") || this.matchKeyword("const")) return this.variableDeclaration(true);
    if (this.matchKeyword("function")) return this.functionDeclaration();
    if (this.matchKeyword("if")) return this.ifStatement();
    if (this.matchKeyword("while")) return this.whileStatement();
    if (this.matchKeyword("for")) return this.forStatement();
    if (this.matchKeyword("return")) {
      if (!this.at(";") && !this.at("}") && this.current.kind !== "eof" && this.current.line === this.previous.line) {
        this.expression();
      }
      return this.endStatement();
    }
    if (this.matchKeyword("throw")) {
      if (this.current.line !== this.previous.line) this.fail("A thrown expression must be on the same line");
      this.expression();
      return this.endStatement();
    }
    if (this.matchKeyword("break") || this.matchKeyword("continue")) {
      if (this.loopDepth === 0) this.fail("break and continue are only allowed inside loops", this.previous);
      return this.endStatement();
    }

    this.expression();
    this.endStatement();
  }

  private block(): void {
    this.expect("{");
    this.scopes.push(new Set());
    while (!this.at("}")) {
      if (this.current.kind === "eof") this.fail("Expected '}'");
      this.statement();
    }
    this.expect("}");
    this.scopes.pop();
  }

  private variableDeclaration(end: boolean): void {
    for (;;) {
      const name = this.expectBindingIdentifier("Expected a variable name");
      this.declare(name);
      if (this.match("=")) this.expression();
      if (!this.match(",")) break;
    }
    if (end) this.endStatement();
  }

  private functionDeclaration(): void {
    const name = this.expectBindingIdentifier("Basic functions must have a name");
    this.declare(name);
    this.expect("(");
    const parameters: string[] = [];
    if (!this.at(")")) {
      do {
        const parameter = this.expectBindingIdentifier("Expected a parameter name");
        if (parameters.includes(parameter.value)) this.fail(`Duplicate parameter '${parameter.value}'`, parameter);
        parameters.push(parameter.value);
      } while (this.match(","));
    }
    this.expect(")");
    this.expect("{");
    this.scopes.push(new Set(parameters));
    while (!this.at("}")) {
      if (this.current.kind === "eof") this.fail("Expected '}'");
      this.statement();
    }
    this.expect("}");
    this.scopes.pop();
  }

  private ifStatement(): void {
    this.parenthesizedExpression();
    this.statement();
    if (this.matchKeyword("else")) this.statement();
  }

  private whileStatement(): void {
    this.parenthesizedExpression();
    this.loopDepth++;
    this.statement();
    this.loopDepth--;
  }

  private forStatement(): void {
    this.expect("(");
    this.scopes.push(new Set());
    if (this.matchKeyword("let") || this.matchKeyword("const")) this.variableDeclaration(false);
    else if (!this.at(";")) this.expression();
    this.expect(";");
    if (!this.at(";")) this.expression();
    this.expect(";");
    if (!this.at(")")) this.expression();
    this.expect(")");
    this.loopDepth++;
    this.statement();
    this.loopDepth--;
    this.scopes.pop();
  }

  private parenthesizedExpression(): void {
    this.expect("(");
    this.expression();
    this.expect(")");
  }

  private expression(): Expression {
    return this.assignment();
  }

  private assignment(): Expression {
    const left = this.conditional();
    if (["=", "+=", "-=", "*=", "/=", "%="].includes(this.current.value)) {
      if (!left.assignable) this.fail("Invalid assignment target");
      this.advance();
      this.assignment();
      return VALUE;
    }
    return left;
  }

  private conditional(): Expression {
    const value = this.binary(1);
    if (this.match("?")) {
      this.assignment();
      this.expect(":");
      this.assignment();
      return VALUE;
    }
    return value;
  }

  private binary(minimumPrecedence: number): Expression {
    let left = this.unary();
    for (;;) {
      const precedence = binaryPrecedence(this.current.value);
      if (precedence < minimumPrecedence) return left;
      this.advance();
      this.binary(precedence + 1);
      left = VALUE;
    }
  }

  private unary(): Expression {
    if (this.matchKeyword("typeof") || this.match("!") || this.match("+") || this.match("-")) {
      this.unary();
      return VALUE;
    }
    if (this.match("++") || this.match("--")) {
      const value = this.unary();
      if (!value.assignable) this.fail("Invalid update target", this.previous);
      return VALUE;
    }
    return this.postfix();
  }

  private postfix(): Expression {
    let value = this.primary();
    for (;;) {
      if (this.match(".")) {
        const property = this.expectIdentifier("Expected a property name");
        this.checkProperty(property.value, property);
        value = { assignable: true, numericLiteral: false };
      } else if (this.match("[")) {
        if (this.current.kind !== "identifier" || this.current.value !== "Number") {
          this.fail("Indexes must have the form value[Number(expression)]");
        }
        this.advance();
        this.expect("(");
        this.expression();
        this.expect(")");
        this.expect("]");
        value = { assignable: true, numericLiteral: false };
      } else if (this.match("(")) {
        if (!this.at(")")) {
          do this.assignment(); while (this.match(","));
        }
        this.expect(")");
        value = VALUE;
      } else if (this.match("++") || this.match("--")) {
        if (!value.assignable) this.fail("Invalid update target", this.previous);
        value = VALUE;
      } else {
        return value;
      }
    }
  }

  private primary(): Expression {
    if (this.current.kind === "number") {
      this.advance();
      return { assignable: false, numericLiteral: true };
    }
    if (this.current.kind === "string" || ["true", "false", "null"].includes(this.current.value)) {
      this.advance();
      return VALUE;
    }
    if (this.current.kind === "identifier") {
      const token = this.current;
      this.advance();
      if (!this.isDeclared(token.value)) this.fail(`Unknown variable '${token.value}'`, token);
      return { assignable: true, numericLiteral: false };
    }
    if (this.match("(")) {
      const value = this.expression();
      this.expect(")");
      return value;
    }
    if (this.match("[")) {
      if (!this.at("]")) do this.assignment(); while (this.match(","));
      this.expect("]");
      return VALUE;
    }
    if (this.match("{")) {
      if (!this.at("}")) {
        do {
          if (!(["identifier", "string", "number"] as TokenKind[]).includes(this.current.kind)) {
            this.fail("Expected an object property name");
          }
          const key = this.current;
          this.advance();
          if (key.kind !== "number") this.checkProperty(key.value, key);
          if (this.match(":")) this.assignment();
          else {
            if (key.kind !== "identifier" || !this.isDeclared(key.value)) {
              this.fail("Object shorthand must name a declared variable", key);
            }
          }
        } while (this.match(",") && !this.at("}"));
      }
      this.expect("}");
      return VALUE;
    }

    this.fail(`Expected an expression, found ${JSON.stringify(this.current.value)}`);
  }

  private endStatement(): void {
    if (this.match(";")) return;
    if (this.current.kind === "eof" || this.at("}") || this.current.line > this.previous.line) return;
    this.fail("Expected ';'");
  }

  private declare(token: Token): void {
    const scope = this.scopes[this.scopes.length - 1]!;
    if (scope.has(token.value)) this.fail(`Duplicate declaration '${token.value}'`, token);
    scope.add(token.value);
  }

  private isDeclared(name: string): boolean {
    return this.scopes.some(scope => scope.has(name));
  }

  private checkProperty(name: string, token: Token = this.previous): void {
    if (FORBIDDEN_PROPERTIES.has(name)) this.fail(`Property '${name}' is not allowed`, token);
  }

  private expectIdentifier(message: string): Token {
    if (this.current.kind !== "identifier") this.fail(message);
    const token = this.current;
    this.advance();
    return token;
  }

  private expectBindingIdentifier(message: string): Token {
    const token = this.expectIdentifier(message);
    if (FORBIDDEN_BINDING_NAMES.has(token.value)) {
      this.fail(`Reserved name '${token.value}' cannot be used as a binding`, token);
    }
    return token;
  }

  private expect(value: string): void {
    if (!this.match(value)) this.fail(`Expected '${value}'`);
  }

  private match(value: string): boolean {
    if (!this.at(value)) return false;
    this.advance();
    return true;
  }

  private matchKeyword(value: string): boolean {
    if (this.current.kind !== "keyword" || this.current.value !== value) return false;
    this.advance();
    return true;
  }

  private at(value: string): boolean {
    return this.current.kind === "punctuator" && this.current.value === value;
  }

  private advance(): void {
    this.previous = this.current;
    this.current = this.nextToken();
  }

  private fail(message: string, token: Token = this.current): never {
    throw new ProcSyntaxError(message, token);
  }
}

function binaryPrecedence(operator: string): number {
  if (operator === "||") return 1;
  if (operator === "&&") return 2;
  if (operator === "===" || operator === "!==") return 3;
  if (["<", "<=", ">", ">="].includes(operator)) return 4;
  if (operator === "+" || operator === "-") return 5;
  if (operator === "*" || operator === "/" || operator === "%") return 6;
  return 0;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentifierStart(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$";
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function isIdentifierName(value: string): boolean {
  if (!isIdentifierStart(value[0] ?? "")) return false;
  for (let index = 1; index < value.length; index++) {
    if (!isIdentifierPart(value[index]!)) return false;
  }
  return true;
}

/**
 * Validate a procedure body against boxOS's deliberately small JavaScript subset.
 * The only names initially in scope are `argumentNames`; all others must be declared locally.
 * Throws ProcSyntaxError when the source is outside the subset.
 */
export function validateProcCode(
  source: string,
  argumentNames: readonly string[] = ["ctx", "arg"],
): void {
  if (typeof source !== "string") throw new TypeError("Procedure code must be a string");
  new Parser(source, argumentNames).parse();
}

export function isValidProcCode(
  source: string,
  argumentNames: readonly string[] = ["ctx", "arg"],
): boolean {
  try {
    validateProcCode(source, argumentNames);
    return true;
  } catch {
    return false;
  }
}
