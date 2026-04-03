export async function readStdinText(
  input: AsyncIterable<string | Buffer>,
): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf-8").trim();
}
