// A throwaway mail server for tests: accepts everything, serves it back over HTTP.
import { createServer } from "node:net";
import { createServer as createHttp } from "node:http";

const messages = [];
createServer((sock) => {
  let data = false; let body = ""; let to = ""; let buf = "";
  sock.write("220 sink ESMTP\r\n");
  sock.on("error", () => {});
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) {
        if (line === ".") { messages.push({ to, body }); data = false; body = ""; sock.write("250 ok\r\n"); } else body += line + "\n";
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250 sink\r\n");
      else if (cmd === "RCPT") { to = line.match(/<(.*)>/)?.[1]?.toLowerCase() ?? ""; sock.write("250 ok\r\n"); }
      else if (cmd === "DATA") { data = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 ok\r\n");
    }
  });
}).listen(Number(process.env.SMTP_PORT ?? 1025));
createHttp((req, res) => {
  const to = new URL(req.url, "http://x").searchParams.get("to")?.toLowerCase();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(messages.filter((m) => !to || m.to === to)));
}).listen(Number(process.env.HTTP_PORT ?? 1080));
