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
    .alias("v", "verbose")
    .boolean("r")
    .alias("r", "readyMode");

// Extra options not defined in optimist to simplify the help:
// -h       Show help
// --trace  Print extra debug information. Turns -v mode on as well.

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
    configRule.headersFilter = configRule.headersFilter || null;
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

function getMatchingConfigRule(requestUrl, method, headers) {
    var requestUrlNoQueryString = requestUrl.split("?")[0];    
    for (var i = 0; i < configArray.length; i++) {
        var configRule = configArray[i];

        // Match method
        if (configRule.method === "" || configRule.method === method) {
            // Match Url
            if (new RegExp("^/?" + configRule.urlFilter + "$").test(
                    requestUrlNoQueryString
                )
            ) {
                trace("configRule.headersFilter: ", configRule.headersFilter)
                if (configRule.headersFilter === null) {
                    return configRule 
                } else {  
                    var counter = 0;
                    // Check if all headers in headersFilter are in request's headers for this config rule
                    for (const header in configRule.headersFilter) {
                        if (headers[header] === configRule.headersFilter[header]) {
                            counter++;
                        }                    
                    }
                    // Check if condition abbove was met for this config rule
                    if (counter == Object.keys(configRule.headersFilter).length) {
                        return configRule;                    
                    }                    
                }
            }
        }
    }
    return defaultRule;
}

function shouldFilterHeader(headerName, requestUrl, requestMethod, headers) {
    var matchingRule = getMatchingConfigRule(requestUrl, requestMethod, headers);
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
                shouldFilterHeader(key, requestUrl, requestMethod, headers) ||
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

function setContentEncodingHeader(headers, encodingValue) {
    headers["Content-Encoding"] = encodingValue;
    delete headers["Content-Length"]; // Since the length will change with the new encoding we need to remove any predefined value
}

function handleResponse(request, response, matchingRule) {
    var responseHeaders = { // Shallow copy so we that we never modify the original configuration object
        ...matchingRule.headers
    };

    // Not much to do if the response is empty
    if (matchingRule.response === "") {
        response.writeHead(matchingRule.status, responseHeaders);
        response.end();
        return;
    }

    var acceptEncodingHeader =
        request.headers["accept-encoding"] ||
        request.headers["Accept-Encoding"] ||
        "";

    var baseWriteResponse = (err, responseContent) => {
        if (err) throw err;
        response.end(responseContent);
    };
    var writeResponse = baseWriteResponse;

    if (matchingRule.encoding !== "") {
        writeResponse = (_, responseContent) => {
            response.end(
                iconv.encode(responseContent, matchingRule.encoding),
                "binary"
            );
        };
    } else if (acceptEncodingHeader.match(/\bgzip\b/)) {
        setContentEncodingHeader(responseHeaders, "gzip");
        writeResponse = (_, responseContent) => {
            zlib.gzip(responseContent, baseWriteResponse);
        };
    } else if (acceptEncodingHeader.match(/\bdeflate\b/)) {
        setContentEncodingHeader(responseHeaders, "deflate");
        writeResponse = (_, responseContent) => {
            zlib.deflate(responseContent, baseWriteResponse);
        };
    }
    
    response.writeHead(matchingRule.status, responseHeaders);
    writeResponse(null, matchingRule.response);
};

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
        
        var matchingRule = getMatchingConfigRule(request.url, request.method, request.headers);
        trace("Response rule: " + jsonutils.inspect(matchingRule));

        handleResponse(request, response, matchingRule);
    });
});

var retryBindCount = 0;
var maxRetryBindCount = 10;

server.on("listening", function(e) {
    retryBindCount = 0;
    if (argv.v) {
        console.log("Server listening on 0.0.0.0:" + argv.p);
    }
    if (argv.r) {
        console.log("Ready!");
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

exports.listen = function(callback) {
    server.listen(argv.p, callback);
};

exports.close = function(callback) {
    server.close(callback);
};
