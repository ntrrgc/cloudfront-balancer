import * as dns from "dns";
import * as dnsd from "dnsd";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import {IncomingMessage, ServerResponse} from "http";
import * as url from "url";

var publicIp = "192.168.0.230";

dnsd.createServer((req, res) => {
    const question = req.question[0];
    console.log(question);
    if (question.type === "A") {
        if (question.name !== "v.vrv.co") {
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
                } else if (err.code === "ENOTFOUND") {
                    res.responseCode = 3; // NXDomain
                } else {
                    res.responseCode = 2; // ServFail
                }
                res.end();
            });
        } else {
            res.answer.push({
                name: question.name,
                type: question.type,
                data: publicIp,
                ttl: 60,
            });
            res.end();
        }
    } else {
        // shrug... this question is not implemented
        res.responseCode = 4; // NotImp
        res.end()
    }
}).listen(53, publicIp);

class ServerRanking {
    private servers = [
        // "37.187.16.8",
        "54.240.184.148",
        "54.240.184.58",
        "54.240.184.43",
        "54.240.184.234",
        "54.240.184.186",
        "54.240.184.202",
        "54.240.184.129",
        "54.240.184.223",
    ];

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

const serverRanking = new ServerRanking();

function proxyRequest(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = url.parse(req.url!);
    if (!req.headers["host"]) {
        res.statusCode = 500;
        res.end("Host header not specified");
        return;
    }

    const chosenServer = serverRanking.chooseServer();


    const reqOptions = <any>{
        port: 443,
        method: req.method,
        path: parsedUrl.path,
        headers: req.headers,
        host: chosenServer,
        servername: req.headers["host"], // TLS Server Name Indication (SNI)
    };
    console.log(reqOptions);

    const proxiedReq = https.request(reqOptions, (proxiedRes) => {
        for (let key in proxiedRes.headers) {
            res.setHeader(key, proxiedRes.headers[key]);
        }
        proxiedRes.pipe(res);
    });
    proxiedReq.end();
    proxiedReq.on("error", (error) => {
        console.log(error);
        res.statusCode = 502;
        res.setHeader("X-Is-CloudFront-Proxy-Error", "true");
        res.end(`Error proxying request: ${error}`);
    });
}

http.createServer(proxyRequest).listen(80, publicIp);

https.createServer({
    key: fs.readFileSync("ca/archive/v.vrv.co/server.key"),
    cert: fs.readFileSync("ca/archive/v.vrv.co/server.crt"),
}, proxyRequest).listen(443, publicIp);