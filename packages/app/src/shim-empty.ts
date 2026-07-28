// Stubs for Node built-ins that the browser build never executes.
// Importing them must not fail; calling them would be a bug, so they throw.
const nope = (name: string) => (): never => {
  throw new Error(`browser build: ${name} is not available`);
};

export const inflateRawSync = nope("zlib.inflateRawSync");
export const createHash = nope("crypto.createHash");
export const readFileSync = nope("fs.readFileSync");
export const writeFileSync = nope("fs.writeFileSync");
export const mkdtempSync = nope("fs.mkdtempSync");
export const mkdirSync = nope("fs.mkdirSync");
export const chmodSync = nope("fs.chmodSync");
export const existsSync = (): boolean => false;
export const rmSync = nope("fs.rmSync");
export const tmpdir = (): string => "/tmp";
export const join = (...p: string[]): string => p.join("/");
export const dirname = (p: string): string => p.split("/").slice(0, -1).join("/");
export const extname = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i);
};
export default {};
