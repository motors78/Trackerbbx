const https = require("https");
const http = require("http");

exports.handler = async function(event) {
  const targetUrl = event.queryStringParameters?.url;

  if (!targetUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Parametro url mancante" })
    };
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
