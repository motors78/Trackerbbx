const https = require("https");
const http = require("http");

exports.handler = async function(event) {
  const targetUrl = event.queryStringParameters?.url;
  const isGroq = event.queryStringParameters?.groq === "1";

  // Chiamata Groq AI
  if (isGroq) {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY non configurata" }) };
    }
    const body = JSON.parse(event.body || "{}");
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const data = await groqRes.json();
    return {
      statusCode: groqRes.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(data)
    };
  }

  // Proxy normale per le quote API
  if (!targetUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: "Parametro url mancante" }) };
  }

  try {
    const data = await new Promise((resolve, reject) => {
      const lib = targetUrl.startsWith("https") ? https : http;
      lib.get(targetUrl, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    return {
      statusCode: data.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: data.body
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
