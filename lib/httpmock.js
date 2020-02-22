var fs = require("fs");
var path = require("path");
var http = require("http");
var zlib = require("zlib");
var jsonutils = require("./jsonutils");
var iconv = require("iconv-lite");

var optimist = require("optimist")
    .usage("Simple http server mock for tests.\nUsage: $0")
    .string("c")
    .alias("c", "config")
    .describe("Configuration file for the responses.")
    .default("p", 8888)
    .alias("p", "port")
    .boolean("v")
    .alias("v", "verbose");

// Extra options not defined in optimist to simplify the help:
//		-h			Show help
//		--trace 	Print extra debug information. Turns -v mode on as well.

var argv = optimist.argv;

if (argv.h) {
    optimist.showHelp();
    process.exit(0);
}

function trace() {
    if (argv.trace) {
        console.log.apply(this, arguments);
        console.log();
    }
}

if (argv.trace) {
    argv.v = argv.verbose = true;
    trace("Arguments: ", jsonutils.inspect(argv));
}

// Read configurations for the responses

var configFile = argv.config
    ? path.resolve(argv.config)
    : path.resolve(__dirname, "../baseConfig.json");
if (!fs.existsSync(configFile)) {
    console.error("Configuration file is missing: '" + configFile + "'");
    process.exit(1);
}

trace("Reading config from: " + configFile);
var configArray = JSON.parse(fs.readFileSync(configFile));

var defaultIgnoredHeaders = ["accept-encoding"];

// Normalize rules, so it's simpler when matching/responding
function normalizeRule(configRule) {
    configRule.status = parseInt(configRule.status || 200);
    configRule.method = configRule.method || "";
    configRule.urlFilter = configRule.urlFilter || "";
    configRule.response = configRule.response || "";
    configRule.encoding = configRule.encoding || "";
    configRule.ignoredHeaders =
        configRule.ignoredHeaders || defaultIgnoredHeaders;
    if (typeof configRule.response !== "string") {
        configRule.response = JSON.stringify(configRule.response);
    }
}

configArray.forEach(normalizeRule);

trace("Config: ", jsonutils.inspect(configArray));

var defaultRule = {
    status: 200,
    response: "No rule was matched.",
    urlFilter: ""
};
normalizeRule(defaultRule);
function getMatchingConfigRule(requestUrl, method) {
    var requestUrlNoQueryString = requestUrl.split("?")[0];
    for (var i = 0; i < configArray.length; i++) {
        var configRule = configArray[i];
        // Match method
        if (configRule.method === "" || configRule.method === method) {
            // Match Url
            if (
                new RegExp("^/?" + configRule.urlFilter + "$").test(
                    requestUrlNoQueryString
                )
            ) {
                return configRule;
            }
        }
    }
    return defaultRule;
}

function shouldFilterHeader(headerName, requestUrl, requestMethod) {
    var matchingRule = getMatchingConfigRule(requestUrl, requestMethod);
    var isToIgnore = !matchingRule.ignoredHeaders.every(function(e) {
        return e != headerName;
    });

    return (
        headerName == "host" ||
        headerName == "connection" ||
        headerName == "expect" ||
        isToIgnore
    );
}

function filterHeaders(headers, requestUrl, requestMethod) {
    var filtered = {};
    Object.keys(headers).forEach(function(key) {
        if (
            !(
                shouldFilterHeader(key, requestUrl, requestMethod) ||
                (key == "content-length" && headers[key] == "0")
            )
        ) {
            filtered[key] = headers[key];
        }
    });
    return filtered;
}

function normalizeUrl(url) {
    return normalizeData(url);
}

function normalizeContent(content) {
    return normalizeData(content);
}

function normalizeData(data) {
    // Normalize encoded data parts to lowercase.
    // Why? Java sends them in uppercase (%3A) and .NET sends them in lowercase (%3a).
    data = data.replace(/%[a-fA-F0-9]{2}/g, function(match) {
        return match.toLowerCase();
    });

    // exception - Java encodes round brackets, while .NET don't
    data = data.replace("%28", "(");
    data = data.replace("%29", ")");

    return data;
}

// Start the server
var server = http.createServer(function(request, response) {
    trace("Handling request: " + request.url);

    var requestDetails = {
        method: request.method,
        url: normalizeUrl(request.url),
        headers: filterHeaders(request.headers, request.url, request.method),
        content: ""
    };

    request.on("data", function(chunk) {
        requestDetails.content += normalizeContent(chunk.toString());
    });

    request.on("end", function() {
        console.log(
            jsonutils.sortedStringify(requestDetails, { indent: "  " })
        );

        var matchingRule = getMatchingConfigRule(request.url, request.method);
        trace("Response rule: " + jsonutils.inspect(matchingRule));

        response.writeHead(matchingRule.status, matchingRule.headers);
        if (matchingRule.response !== "") {
            if (matchingRule.encoding === "") {
                var acceptEncoding = request.headers["accept-encoding"];
                trace("Accept-Encoding header: " + acceptEncoding);
                if (!acceptEncoding) {
                    acceptEncoding = "";
                }

                if (acceptEncoding.match(/\bgzip\b/)) {
                    response.writeHead(matchingRule.status, {
                        "Content-Encoding": "gzip"
                    });
                    zlib.gzip(matchingRule.response, (err, buffer) => {
                        if (err) throw err;
                        response.end(buffer);
                    });
                } else if (acceptEncoding.match(/\bdeflate\b/)) {
                    response.writeHead(matchingRule.status, {
                        "Content-Encoding": "deflate"
                    });
                    zlib.deflate(matchingRule.response, (err, buffer) => {
                        if (err) throw err;
                        response.end(buffer);
                    });
                } else {
                    response.end(matchingRule.response);
                }
            } else {
                response.end(
                    iconv.encode(matchingRule.response, matchingRule.encoding),
                    "binary"
                );
            }
        } else {
            response.end();
        }
    });
});

var retryBindCount = 0;
var maxRetryBindCount = 10;

server.on("listening", function(e) {
    retryBindCount = 0;
    if (argv.v) {
        console.log("Server listening on 0.0.0.0:" + argv.p);
    }
});

server.on("error", function(e) {
    if (e.code == "EADDRINUSE") {
        //argv.p += 1; //Retry on a different port?
        retryBindCount += 1;
        if (retryBindCount <= maxRetryBindCount) {
            console.warn("Address in use, retrying on 0.0.0.0:" + argv.p);
            setTimeout(function() {
                server.listen(argv.p);
            }, 500);
        } else {
            console.error("Address in use, giving up");
            process.exit(2);
        }
    }
});

exports.listen = function (callback) {
    server.listen(argv.p, callback);
};
  
exports.close = function (callback) {
    server.close(callback);
};

