const http = require("http");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/tool/download") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let path = "";
      try {
        path = JSON.parse(body).path || "";
      } catch {
        path = "";
      }

      if (String(path).includes("302")) {
        res.statusCode = 302;
        res.setHeader("Location", `https://dl.example/redirect?path=${encodeURIComponent(path)}`);
        res.end("");
        return;
      }

      res.setHeader("Content-Type", "application/json");
      const rules = req.headers["x-path-prefix-rules"] || "";
      res.end(
        JSON.stringify({
          url: `https://dl.example/json?path=${encodeURIComponent(path)}&rules=${encodeURIComponent(String(rules))}`,
          rules
        })
      );
    });
    return;
  }

  if (req.url === "/health") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(8115, "127.0.0.1");
