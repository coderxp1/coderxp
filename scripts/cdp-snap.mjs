import http from "node:http";

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  console.log("Checking CDP targets on http://localhost:9222/json");
  const targets = await fetchJson("http://localhost:9222/json");
  console.log("Found targets:", targets);
}

main().catch(console.error);
