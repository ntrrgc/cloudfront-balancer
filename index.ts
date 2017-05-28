import * as dns from "dns";
import * as dnsd from "dnsd";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import {IncomingMessage, ServerResponse} from "http";
import * as url from "url";
import * as filesize from "filesize";
import {SkipBytes} from "./SkipBytes";

let publicIp = process.argv[2] || "192.168.0.230";
let interceptedDomain = process.argv[3] || "v.vrv.co";
let interceptionTTL = 60;
// Used to resolve the intercepted domain and any incoming DNS questions
dns.setServers(["208.67.222.222", "208.67.220.220"]);

const dnsServer = dnsd.createServer((req, res) => {
    const question = req.question[0];
    if (question.type === "A") {
        if (question.name !== interceptedDomain) {
            dns.resolve4(question.name, {ttl: true}, (err, records) => {
                if (!err) {
                    records.forEach(record => {
                        res.answer.push({
                            name: question.name,
                            type: question.type,
                            data: record.address,
                            ttl: record.ttl,
                        });
                    });
                    console.log(`DNS: ${question.name} A ${records[0].address} ${records[0].ttl}`);
                } else if (err.code === "ENOTFOUND") {
                    console.log(`DNS: ${question.name} A NXDomain`);
                    res.responseCode = 3; // NXDomain
                } else {
                    console.error(err);
                    console.log(`DNS: ${question.name} A ServFail`);
                    res.responseCode = 2; // ServFail
                }
                res.end();
            });
        } else {
            res.answer.push({
                name: question.name,
                type: question.type,
                data: publicIp,
                ttl: interceptionTTL,
            });
            console.log(`DNS: ${question.name} A ${publicIp} ${interceptionTTL} (intercepted)`);
            res.end();
        }
    } else {
        // shrug... this question is not implemented
        res.responseCode = 4; // NotImp
        console.log(`DNS: ${question.name} ${question.type} NotImp`);
        res.end()
    }
});
dnsServer.on("error", (error) => {
    console.error(error);
});

class ServerRanking {
    private servers: string[];

    initializeServers() {
        return new Promise<void>((resolve, reject) => {
            dns.resolve4(interceptedDomain, ((err, addresses) => {
                if (err) return reject(err);
                this.servers = addresses;
                resolve();
            }))
        })
    }

    chooseServer(): string {
        return this.servers[0];
    }

    reportBadServer(server: string) {
        const pos = this.servers.indexOf(server);
        if (pos == -1) throw new Error(`server not found: ${server}`);
        // Move to the end of the queue
        this.servers.splice(pos, 1);
        this.servers.push(server);
    }
}

function runProxiedSession(reqOpts: any, skipBytes: number, timeout: number, res: ServerResponse,
                           onFinished: (success: boolean, totalBytesSent: number, timeSpent: number) => void)
{
    let thisRequestBytesSent = 0;
    const startTime = process.uptime();

    const proxiedReq = https.request(reqOpts, (proxiedRes) => {
        // When the proxy response headers arrive...

        // Set the client response headers if this is the first time
        // (no bytes have been transferred yet)
        if (!res.headersSent) {
            res.statusCode = proxiedRes.statusCode!;
            for (let key in proxiedRes.headers) {
                res.setHeader(key, proxiedRes.headers[key]);
            }
        }

        const skipper = new SkipBytes(skipBytes);
        let finished = false;

        const dataStreamForClient: NodeJS.ReadableStream = proxiedRes.pipe(skipper);
        dataStreamForClient
            .on("readable", () => {
                const chunk = dataStreamForClient.read();
                if (!finished && chunk != null) {
                    res.write(chunk);
                    thisRequestBytesSent += chunk.length;
                }
            })
            .on("end", () => {
                if (!finished) {
                    finished = true;
                    res.end();
                    onFinished(true, skipBytes + thisRequestBytesSent, process.uptime() - startTime);
                }
            })
            .on("error", () => {
                if (!finished) {
                    finished = true;
                    onFinished(false, skipBytes + thisRequestBytesSent, process.uptime() - startTime);
                }
            });

        setTimeout(() => {
            if (!finished) {
                finished = true;

                // Stop processing data and abort the request
                proxiedRes.unpipe(skipper);
                dataStreamForClient.removeAllListeners();
                proxiedReq.abort();

                onFinished(false, skipBytes + thisRequestBytesSent, process.uptime() - startTime);
            }
        }, timeout);
    });

    proxiedReq.on("error", (error) => {
        console.log(error);
        res.statusCode = 502;
        res.setHeader("X-Is-CloudFront-Proxy-Error", "true");
        res.end(`Error proxying request: ${error}`);
    });

    // Send the request
    proxiedReq.end();
}

function proxyRequest(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = url.parse(req.url!);
    if (!req.headers["host"]) {
        res.statusCode = 500;
        res.end("Host header not specified");
        return;
    }

    let skipBytes = 0;
    let chosenServer: string = serverRanking.chooseServer();
    function tryNextServer() {
        const reqOptions = <any>{
            port: 443,
            method: req.method,
            path: parsedUrl.path,
            headers: req.headers,
            host: chosenServer,
            servername: req.headers["host"], // TLS Server Name Indication (SNI)
        };

        runProxiedSession(reqOptions, skipBytes, 8000, res, (success, totalBytesSent, timeSpent) => {
            if (!success) {
                // Retry with next server
                serverRanking.reportBadServer(chosenServer);
                const newChosenServer = serverRanking.chooseServer();

                console.log(`${chosenServer}: Server seems slow. Retrying next with ${newChosenServer} after ${filesize(totalBytesSent)}`);
                chosenServer = newChosenServer;
                skipBytes = totalBytesSent;
                tryNextServer();
            } else {
                // Print stats
                const bytesPerSecond = totalBytesSent / timeSpent;
                console.log(`${chosenServer}: Downloaded ${filesize(totalBytesSent)} in ${timeSpent.toFixed(2)} seconds (${filesize(bytesPerSecond)}/s)`)
            }
        })
    }

    // Loop through the servers until the request response is streamed timely
    // with any of them.
    tryNextServer();
}

const serverRanking = new ServerRanking();
serverRanking.initializeServers()
    .then(() => new Promise<void>((resolve, reject) => {
        http.createServer(proxyRequest).listen(80, publicIp, (err) => {
            if (err) reject(err);
            else resolve();
        });
    }))
    .then(() => new Promise<void>((resolve, reject) => {
        https.createServer({
            key: fs.readFileSync(`ca/archive/${interceptedDomain}/server.key`),
            cert: fs.readFileSync(`ca/archive/${interceptedDomain}/server.crt`),
        }, proxyRequest).listen(443, publicIp, (err) => {
            if (err) reject();
            else resolve();
        });
    }))
    .then(() => new Promise<void>((resolve, reject) => {
        dnsServer.listen(53, publicIp, (err) => {
            if (err) reject();
            else resolve();
        })
    }))
    .then(() => {
        console.log("Load balancer listening on ports 53 (DNS), 80 (HTTP) and 443 (HTTPS).");
    });