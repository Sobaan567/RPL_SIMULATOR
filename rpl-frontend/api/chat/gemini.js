export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ detail: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ detail: "GEMINI_API_KEY is not set on Vercel" });
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const { messages = [], simulator_context: simulatorContext = {} } = req.body || {};
  const systemText = [
    "You are a helpful assistant inside an RPL network simulator.",
    "Answer clearly and concisely. When useful, relate answers to DODAG formation, DIO, DAO, DATA, ACK, rank, ETX, energy drain, hotspots, and repair.",
    `Current simulator context JSON: ${JSON.stringify(simulatorContext).slice(0, 3000)}`,
  ].join(" ");

  const contents = [{ role: "user", parts: [{ text: systemText }] }];
  for (const msg of messages.slice(-12)) {
    const text = String(msg?.text || "").trim();
    if (!text) continue;
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: text.slice(0, 4000) }],
    });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 700,
          },
        }),
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        detail: data?.error?.message || "Gemini API error",
      });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const reply = parts.map(part => part.text || "").join("").trim();
    return res.status(200).json({
      reply: reply || "Gemini returned an empty response. Try asking again.",
      model,
    });
  } catch (error) {
    return res.status(502).json({ detail: `Could not reach Gemini API: ${error.message}` });
  }
}
