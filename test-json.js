const finalText = "```json\n{\"tool\": \"run\"}\n```\n```json\n{\"final\": \"output\"}\n```";
const jsonMatch = finalText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
console.log("match gives:", jsonMatch ? jsonMatch[1].trim() : "null");

const finalText2 = "{\"tool\": \"run\"}\nSome text\n{\"final\": \"output\"}";
const firstBrace = finalText2.indexOf("{");
const lastBrace = finalText2.lastIndexOf("}");
console.log("substring gives:\n", finalText2.substring(firstBrace, lastBrace + 1));
