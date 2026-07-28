// Minimal, dependency-free XML parser for DART dart4 contents.xml (Doc 03 §2.2.1, §3.2).
//
// The DART body XML is well-formed and constrained (verified on the 인터플렉스 2025
// sample): a single <?xml?> declaration, no comments, no CDATA, no self-closing
// tags, and only the standard entities &amp; &lt; &gt; &quot; &apos;. This parser
// is intentionally small and deterministic (§19); it is NOT a general XML engine.
// It tolerates self-closing tags defensively in case other schema versions emit them.

export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export interface XmlText {
  type: "text";
  value: string;
}
export type XmlNode = XmlElement | XmlText;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the standard XML entities plus numeric character references. */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const rep = ENTITIES[body];
    return rep !== undefined ? rep : m;
  });
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9:_.\-]/.test(ch);
}

/**
 * Parse an XML document string into a single root element.
 * Throws on malformed input (unbalanced tags) — surfaced to the caller rather
 * than guessed at (§5 Zero Hallucination: never fabricate structure).
 */
export function parseXml(input: string): XmlElement {
  let i = 0;
  const n = input.length;

  // Skip a leading BOM.
  if (input.charCodeAt(0) === 0xfeff) i = 1;

  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  const attachText = (raw: string): void => {
    const parent = stack[stack.length - 1];
    if (!parent) return; // ignore whitespace/text outside the root element
    parent.children.push({ type: "text", value: decodeEntities(raw) });
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      // trailing text after the last tag (should be whitespace only)
      break;
    }
    if (lt > i) attachText(input.slice(i, lt));

    // Directives / declarations / comments.
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt);
      if (end === -1) throw new Error("xml: unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt);
      if (end === -1) throw new Error("xml: unterminated comment");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt);
      if (end === -1) throw new Error("xml: unterminated CDATA");
      attachText(input.slice(lt + 9, end)); // CDATA is literal, no entity decode
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      // DOCTYPE or similar — skip to the matching '>'.
      const end = input.indexOf(">", lt);
      if (end === -1) throw new Error("xml: unterminated declaration");
      i = end + 1;
      continue;
    }

    // Closing tag </NAME>
    if (input[lt + 1] === "/") {
      const end = input.indexOf(">", lt);
      if (end === -1) throw new Error("xml: unterminated end tag");
      const name = input.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new Error(
          `xml: mismatched end tag </${name}> (open: ${top ? top.name : "none"})`,
        );
      }
      i = end + 1;
      continue;
    }

    // Opening tag <NAME attr="..." ...> or <NAME .../>
    let j = lt + 1;
    const nameStart = j;
    while (j < n && isNameChar(input[j]!)) j++;
    const name = input.slice(nameStart, j);
    if (!name) throw new Error(`xml: invalid tag at ${lt}`);

    const attrs: Record<string, string> = {};
    let selfClose = false;
    // Parse attributes until '>' (respecting quotes).
    while (j < n) {
      const ch = input[j]!;
      if (ch === ">") {
        j++;
        break;
      }
      if (ch === "/" && input[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        j++;
        continue;
      }
      // attribute name
      const aStart = j;
      while (j < n && isNameChar(input[j]!)) j++;
      const aName = input.slice(aStart, j);
      // skip spaces
      while (j < n && /\s/.test(input[j]!)) j++;
      if (input[j] === "=") {
        j++;
        while (j < n && /\s/.test(input[j]!)) j++;
        const q = input[j];
        if (q === '"' || q === "'") {
          const close = input.indexOf(q, j + 1);
          if (close === -1) throw new Error(`xml: unterminated attribute ${aName}`);
          attrs[aName] = decodeEntities(input.slice(j + 1, close));
          j = close + 1;
        } else {
          // unquoted value
          const vStart = j;
          while (j < n && !/[\s/>]/.test(input[j]!)) j++;
          attrs[aName] = decodeEntities(input.slice(vStart, j));
        }
      } else if (aName) {
        attrs[aName] = ""; // valueless attribute
      } else {
        j++; // stray character; advance to avoid infinite loop
      }
    }

    const el: XmlElement = { type: "element", name, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;

    if (!selfClose) stack.push(el);
    i = j;
  }

  if (stack.length > 0) {
    throw new Error(`xml: unclosed tag <${stack[stack.length - 1]!.name}>`);
  }
  if (!root) throw new Error("xml: no root element");
  return root;
}

/** Concatenate all descendant text of an element, entity-decoded. */
export function textOf(el: XmlElement): string {
  let out = "";
  for (const c of el.children) {
    if (c.type === "text") out += c.value;
    else out += textOf(c);
  }
  return out;
}

/** Direct element children (optionally filtered by tag name). */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.type === "element" && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

/** First matching descendant (depth-first) by tag name. */
export function firstDescendant(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) {
    if (c.type !== "element") continue;
    if (c.name === name) return c;
    const found = firstDescendant(c, name);
    if (found) return found;
  }
  return undefined;
}
