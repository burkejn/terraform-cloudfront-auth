const qs = require('querystring');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const jwkToPem = require('jwk-to-pem');
const auth = require('./auth.js');
const nonce = require('./nonce.js');
const axios = require('axios');

let discoveryDocument;
let jwks;
let config;

exports.handler = (event, context, callback) => {
  if (typeof jwks === 'undefined' || typeof discoveryDocument === 'undefined' || typeof config === 'undefined') {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
    axios.get(config.DISCOVERY_DOCUMENT)
      .then((resp) => {
        discoveryDocument = resp.data;
        if (!discoveryDocument.hasOwnProperty('jwks_uri')) {
          console.log("Internal server error: missing jwks_uri in discovery document");
          return internalServerError(callback);
        }
        return axios.get(discoveryDocument.jwks_uri);
      })
      .then((resp) => {
        jwks = resp.data;
        mainProcess(event, context, callback);
      })
      .catch((err) => {
        console.log("Internal server error:", err.message);
        internalServerError(callback);
      });
  } else {
    mainProcess(event, context, callback);
  }
};

function mainProcess(event, context, callback) {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const queryDict = qs.parse(request.querystring);

  if (event.Records[0].cf.config.hasOwnProperty('test')) {
    config.AUTH_REQUEST.redirect_uri  = event.Records[0].cf.config.test + config.CALLBACK_PATH;
    config.TOKEN_REQUEST.redirect_uri = event.Records[0].cf.config.test + config.CALLBACK_PATH;
  }

  if (request.uri.startsWith(config.CALLBACK_PATH)) {
    // OAuth callback
    if (queryDict.error) {
      return unauthorized(prettyOAuthError(queryDict.error), queryDict.error_description || '', queryDict.error_uri || '', callback);
    }
    if (!queryDict.code) {
      return unauthorized('No Code Found', '', '', callback);
    }

    const tokenReq = { ...config.TOKEN_REQUEST, code: queryDict.code };
    const options = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };

    if (config.TOKEN_REQUEST.client_secret) {
      const basic = Buffer.from(`${config.TOKEN_REQUEST.client_id}:${config.TOKEN_REQUEST.client_secret}`, 'utf8').toString('base64');
      options.headers['Authorization'] = `Basic ${basic}`;
    }
    delete tokenReq.client_secret;

    axios.post(discoveryDocument.token_endpoint, qs.stringify(tokenReq), options)
      .then((resp) => {
        const decodedData = jwt.decode(resp.data.id_token, { complete: true });

        try {
          let pem = "";
          for (let i = 0; i < jwks.keys.length; i++) {
            if (decodedData.header.kid === jwks.keys[i].kid) {
              pem = jwkToPem(jwks.keys[i]);
              break;
            }
          }

          jwt.verify(resp.data.id_token, pem, { algorithms: ['RS256'] }, (err, decoded) => {
            if (err) {
              if (err.name === 'TokenExpiredError') return redirect(request, headers, callback);
              if (err.name === 'JsonWebTokenError') return unauthorized('Json Web Token Error', err.message, '', callback);
              return unauthorized('Unknown JWT', `User ${decodedData?.payload?.email || ''} is not permitted.`, '', callback);
            }

            // Validate nonce
            if ("cookie" in headers &&
                "NONCE" in cookie.parse(headers["cookie"][0].value) &&
                nonce.validateNonce(decoded.nonce, cookie.parse(headers["cookie"][0].value).NONCE)) {

              console.log("Setting session cookie and redirecting.");
              const response = {
                status: "302",
                statusDescription: "Found",
                body: "ID token retrieved.",
                headers: {
                  location : [{
                    key: "Location",
                    value: event.Records[0].cf.config.hasOwnProperty('test') ? (config.AUTH_REQUEST.redirect_uri + queryDict.state) : queryDict.state
                  }],
                  "set-cookie" : [
                    {
                      key: "Set-Cookie",
                      value : cookie.serialize('TOKEN', jwt.sign(
                        {},
                        config.PRIVATE_KEY.trim(),
                        {
                          audience: headers.host[0].value,
                          subject: auth.getSubject(decodedData),
                          expiresIn: config.SESSION_DURATION,
                          algorithm: "RS256"
                        }
                      ), {
                        path: '/',
                        maxAge: config.SESSION_DURATION,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'lax'
                      })
                    },
                    {
                      key: "Set-Cookie",
                      value : cookie.serialize('NONCE', '', {
                        path: '/',
                        expires: new Date(1970, 1, 1, 0, 0, 0, 0),
                        httpOnly: true,
                        secure: true,
                        sameSite: 'lax'
                      })
                    }
                  ],
                },
              };
              return callback(null, response);
            } else {
              return unauthorized('Nonce Verification Failed', '', '', callback);
            }
          });
        } catch (e) {
          console.log("Internal server error:", e.message);
          internalServerError(callback);
        }
      })
      .catch((err) => {
        console.log("Internal server error:", err.message);
        internalServerError(callback);
      });

  } else if ("cookie" in headers && "TOKEN" in cookie.parse(headers["cookie"][0].value)) {
    // Validate existing session
    jwt.verify(cookie.parse(headers["cookie"][0].value).TOKEN, config.PUBLIC_KEY.trim(), { algorithms: ['RS256'] }, (err, decoded) => {
      if (err) {
        if (err.name === 'TokenExpiredError') return redirect(request, headers, callback);
        if (err.name === 'JsonWebTokenError') return unauthorized('Json Web Token Error', err.message, '', callback);
        return unauthorized('Unauthorized.', `User ${decoded?.sub || ''} is not permitted.`, '', callback);
      }
      auth.isAuthorized(decoded, request, callback, unauthorized, internalServerError, config);
    });

  } else {
    // No session → auth redirect
    return redirect(request, headers, callback);
  }
}

function redirect(request, headers, callback) {
  const n = nonce.getNonce();
  config.AUTH_REQUEST.nonce = n[0];
  config.AUTH_REQUEST.state = request.uri;

  const response = {
    status: "302",
    statusDescription: "Found",
    body: "Redirecting to OIDC provider",
    headers: {
      location : [{
        key: "Location",
        value: discoveryDocument.authorization_endpoint + '?' + qs.stringify(config.AUTH_REQUEST)
      }],
      "set-cookie" : [
        {
          key: "Set-Cookie",
          value : cookie.serialize('TOKEN', '', {
            path: '/',
            expires: new Date(1970, 1, 1, 0, 0, 0, 0),
            httpOnly: true,
            secure: true,
            sameSite: 'lax'
          })
        },
        {
          key: "Set-Cookie",
          value : cookie.serialize('NONCE', n[1], {
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'lax'
          })
        }
      ],
    },
  };
  callback(null, response);
}

// --- helpers below (unchanged content except minor tidy) ---

function prettyOAuthError(code) {
  const map = {
    invalid_request: "Invalid Request",
    unauthorized_client: "Unauthorized Client",
    access_denied: "Access Denied",
    unsupported_response_type: "Unsupported Response Type",
    invalid_scope: "Invalid Scope",
    server_error: "Server Error",
    temporarily_unavailable: "Temporarily Unavailable"
  };
  return map[code] || code;
}

function unauthorized(error, error_description, error_uri, callback) {
  let page = `<!DOCTYPE html><html lang="en"><head>
  <!-- Simple HttpErrorPages -->
  <meta charset="utf-8"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>We've got some trouble 401 - Unauthorized</title>
  <style type="text/css">/* styles omitted for brevity */</style>
  </head><body>
  <div class="cover"><h1>${error} <small>Error 401</small></h1><p class="lead">${error_description}</p><p>${error_uri}</p></div>
  <footer><p><a href="https://github.com/widen/cloudfront-auth">cloudfront-auth</a></p></footer>
  </body></html>`;

  const response = {
    status: "401",
    statusDescription: "Unauthorized",
    body: page,
    headers: {
      "set-cookie" : [
        {
          key: "Set-Cookie",
          value : cookie.serialize('TOKEN', '', {
            path: '/',
            expires: new Date(1970, 1, 1, 0, 0, 0, 0),
            httpOnly: true,
            secure: true,
            sameSite: 'lax'
          })
        },
        {
          key: "Set-Cookie",
          value : cookie.serialize('NONCE', '', {
            path: '/',
            expires: new Date(1970, 1, 1, 0, 0, 0, 0),
            httpOnly: true,
            secure: true,
            sameSite: 'lax'
          })
        }
      ],
    },
  };
  callback(null, response);
}

function internalServerError(callback) {
  let page = `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>We've got some trouble 500 - Internal Server Error</title>
  <style type="text/css">/* styles omitted for brevity */</style>
  </head><body>
  <div class="cover"><h1>Internal Server Error <small>Error 500</small></h1></div>
  <footer><p><a href="https://github.com/widen/cloudfront-auth">cloudfront-auth</a></p></footer>
  </body></html>`;

  const response = {
    status: "500",
    statusDescription: "Internal Server Error",
    body: page,
  };
  callback(null, response);
}