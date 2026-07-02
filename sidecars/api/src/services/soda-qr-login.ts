import {
  ProviderLoginQrCheckSchema,
  ProviderLoginQrImageSchema,
  type ProviderLoginQrCheck,
  type ProviderLoginQrImage,
} from "@mineradio/shared";

import { setRuntimeProviderCookie } from "./auth-session";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type SodaApiResponse = {
  body?: unknown;
  cookie?: unknown;
};

type SodaApiCall = (
  query: Record<string, unknown>,
  config?: { cookie?: string }
) => Promise<SodaApiResponse>;

export type SodaQrLoginService = {
  createImage(): Promise<ProviderLoginQrImage>;
  check(key: string): Promise<ProviderLoginQrCheck>;
};

export type SodaQrLoginDeps = {
  fetch?: FetchLike;
  qrCreate?: SodaApiCall;
  now?: () => number;
  qrCodeUrl?: string;
  qrCheckUrl?: string;
  qrCheckReferer?: string;
  qrCheckUserAgent?: string;
};

const SODA_PROVIDER = "soda";
const SODA_QR_CODE_URL = "https://api.qishui.com/passport/web/get_qrcode/?passport_jssdk_version=2.4.13&passport_jssdk_type=normal&is_from_ttaccountsdk=1&aid=386088&language=zh&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1&account_sdk_source=web&account_sdk_source_info=7e276d64776172647760466a6b66707777606b667c273f3637292772606761776c736077273f63646976602927666d776a686061776c736077273f63646976602927766d60696961776c736077273f63646976602927756970626c6b76273f302927756077686c76766c6a6b76273f5e7e276b646860273f276b6a716c636c6664716c6a6b762729277671647160273f276277646b71606127785829276c6b6b60774d606c626d71273f32373529276c6b6b6077526c61716d273f3434353529276a707160774d606c626d71273f32373529276a70716077526c61716d273f34343535292776716a64776260567164717076273f7e276c6b61607d60614147273f7e276c6167273f276a676f6066712729276a75606b273f2763706b66716c6a6b2729276c6b61607d60614147273f276a676f6066712729274c41474e607c57646b6260273f2763706b66716c6a6b2729276a75606b4164716467647660273f27706b6160636c6b60612729276c7656646364776c273f636469766029276d6476436071666d273f6364697660782927696a66646956716a77646260273f7e276c76567075756a77714956716a77646260273f717770602927766c7f60273f363c3c31343c292772776c7160273f7177706078292776716a7764626054706a7164567164717076273f7e277076646260273f34303230313731292774706a7164273f37313637373334323335353529276c7655776c73647160273f6364697660787829277260676269273f7e2773606b616a77273f27426a6a626960254c6b662b252d4b534c414c442c27292777606b6160776077273f27444b424940252d4b534c414c4429254b534c414c44254260436a7766602557515d2530353235252d357d35353535374335312c25416c77606671364134342573765a305a352575765a305a35292541364134342c277829276b6a716c636c6664716c6a6b556077686c76766c6a6b273f276277646b716061272927756077636a7768646b6660273f7e27716c68604a776c626c6b273f34323d373c373c3137353c33312b322927707660614f564d606475566c7f60273f323737353535353529276b64736c6264716c6a6b516c686c6b62273f7e276160666a616061476a617c566c7f60273f37343c312927606b71777c517c7560273f276b64736c6264716c6a6b2729276c6b6c716c64716a77517c7560273f276b64736c6264716c6a6b2729276b646860273f276475753f2a2a7760766a70776660762a68646c6b2b647664772a68646c6b2b6d7168693a62696a6764695a666a6b636c62382032472037377076607741647164203737203644203737462036442030462030465076607776203046203046373034353520304620304644757541647164203046203046576a64686c6b62203046203046566a61644870766c662037372037462037376160736c66604c61203737203644203737303433353c3c33363437373d3c3d3d2037372037462037376c6b76716469694c612037372036442037373432373c3c33353d343033363433363320373720374620373768646c6b55776a6660767646776064716c6a6b516c686020373720364434323d373c373c3134313235352b3c3d3d2037462037376a76203737203644203737526c6b616a72762037372037462037376a765760696064766020373720364420373734352b352b373c303233203737203746203737666a6875707160774b646860203737203644203737465d5534572037372037462037376d7171754d6064616077762037372036442032472032412037462037377360776c637c517764666e4073606b712037372036446364697660203746203737666d646b6b60692037372036442037376a63636c666c6469203737203746203737636a6b71557760636c7d2037372036442037376475752036442037432037437760766a7077666076203743636a6b717620373720324127292777606b61607747696a666e6c6b62567164717076273f276b6a6b2867696a666e6c6b62272927766077736077516c686c6b62273f27272927627069605671647771273f276b6a6b602729276270696041707764716c6a6b273f276b6a6b602778782927776074706076715a6d6a7671273f277760766a7077666076272927776074706076715a7564716d6b646860273f272a68646c6b2b647664772a68646c6b2b6d71686927292767776a72766077273f7e2771273f27363d363137313c373c373d3234272927676c715a75776a716a666a69273f276364697660272927676c715a6d6069756077273f63646976607878";
const SODA_QR_CHECK_URL = "https://api.qishui.com/passport/web/check_qrconnect/?passport_jssdk_version=2.4.13&passport_jssdk_type=normal&is_from_ttaccountsdk=1&aid=386088&language=zh&account_sdk_source=web&account_sdk_source_info=7e276d64776172647760466a6b66707777606b667c273f3637292772606761776c736077273f63646976602927666d776a686061776c736077273f63646976602927766d60696961776c736077273f63646976602927756970626c6b76273f302927756077686c76766c6a6b76273f5e7e276b646860273f276b6a716c636c6664716c6a6b762729277671647160273f276277646b71606127785829276c6b6b60774d606c626d71273f32373529276c6b6b6077526c61716d273f3434353529276a707160774d606c626d71273f32373529276a70716077526c61716d273f34343535292776716a64776260567164717076273f7e276c6b61607d60614147273f7e276c6167273f276a676f6066712729276a75606b273f2763706b66716c6a6b2729276c6b61607d60614147273f276a676f6066712729274c41474e607c57646b6260273f2763706b66716c6a6b2729276a75606b4164716467647660273f27706b6160636c6b60612729276c7656646364776c273f636469766029276d6476436071666d273f6364697660782927696a66646956716a77646260273f7e276c76567075756a77714956716a77646260273f717770602927766c7f60273f363c3c31343c292772776c7160273f7177706078292776716a7764626054706a7164567164717076273f7e277076646260273f34303230313731292774706a7164273f37313637373334323335353529276c7655776c73647160273f6364697660787829277260676269273f7e2773606b616a77273f27426a6a626960254c6b662b252d4b534c414c442c27292777606b6160776077273f27444b424940252d4b534c414c4429254b534c414c44254260436a7766602557515d2530353235252d357d35353535374335312c25416c77606671364134342573765a305a352575765a305a35292541364134342c277829276b6a716c636c6664716c6a6b556077686c76766c6a6b273f276277646b716061272927756077636a7768646b6660273f7e27716c68604a776c626c6b273f34323d373c373c3137353c33312b322927707660614f564d606475566c7f60273f323737353535353529276b64736c6264716c6a6b516c686c6b62273f7e276160666a616061476a617c566c7f60273f37343c312927606b71777c517c7560273f276b64736c6264716c6a6b2729276c6b6c716c64716a77517c7560273f276b64736c6264716c6a6b2729276b646860273f276475753f2a2a7760766a70776660762a68646c6b2b647664772a68646c6b2b6d7168693a62696a6764695a666a6b636c62382032472037377076607741647164203737203644203737462036442030462030465076607776203046203046373034353520304620304644757541647164203046203046576a64686c6b62203046203046566a61644870766c662037372037462037376160736c66604c61203737203644203737303433353c3c33363437373d3c3d3d2037372037462037376c6b76716469694c612037372036442037373432373c3c33353d343033363433363320373720374620373768646c6b55776a6660767646776064716c6a6b516c686020373720364434323d373c373c3134313235352b3c3d3d2037462037376a76203737203644203737526c6b616a72762037372037462037376a765760696064766020373720364420373734352b352b373c303233203737203746203737666a6875707160774b646860203737203644203737465d5534572037372037462037376d7171754d6064616077762037372036442032472032412037462037377360776c637c517764666e4073606b712037372036446364697660203746203737666d646b6b60692037372036442037376a63636c666c6469203737203746203737636a6b71557760636c7d2037372036442037376475752036442037432037437760766a7077666076203743636a6b717620373720324127292777606b61607747696a666e6c6b62567164717076273f276b6a6b2867696a666e6c6b62272927766077736077516c686c6b62273f27272927627069605671647771273f276b6a6b602729276270696041707764716c6a6b273f276b6a6b602778782927776074706076715a6d6a7671273f277760766a7077666076272927776074706076715a7564716d6b646860273f272a68646c6b2b647664772a68646c6b2b6d71686927292767776a72766077273f7e2771273f27363d363137313c373c373d3234272927676c715a75776a716a666a69273f276364697660272927676c715a6d6069756077273f63646976607878&p_js_v=2.4.13&p_js_t=pro&p_zt=3.3.5&p_ver=1.0.29&request_host=app%253A%252F%252Fresources&p_bd=1.0.0.41&biz_trace_id=02acd038&is_new_login=1&is_from_iesaccountsaas=1&device_id=&install_id=27960026095955&did=&iid=27960026095955&device_platform=PC&version_code=3.5.1&msToken=9YWQCc4l6SALhEHzESC2zganl-MNU-zOIH6Naxqj6wGDKk87xKKZ4M0iPUcMNDLP7Z4Wk6y7AxcQgy8XeoucIzWQtXwRaHn2EbjnxrEAksp-T7xdBRTfKw%3D%3D&a_bogus=Yf4DkO22Msm1gPtHE7kz9reYqnL0YW-fgZEP7BYSTUwV";
const SODA_QR_CHECK_REFERER = "https://api.qishui.com/";
const SODA_QR_CHECK_USER_AGENT = "LunaPC/2.6.5(197449790)";

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function responseBody(resp: SodaApiResponse): Record<string, unknown> {
  return asObj(resp.body) ?? {};
}

function responseData(resp: SodaApiResponse): Record<string, unknown> {
  const body = responseBody(resp);
  return asObj(body.data) ?? body;
}

function readQrToken(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readString(data.token) ??
    readString(data.key) ??
    readString(data.unikey) ??
    readString(body.token) ??
    readString(body.key) ??
    readString(body.unikey)
  );
}

function readQrImage(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return (
    readString(data.qrcode) ??
    readString(data.qrimg) ??
    readString(data.img) ??
    readString(data.image) ??
    readString(body.qrcode) ??
    readString(body.qrimg) ??
    readString(body.img) ??
    readString(body.image)
  );
}

function readQrUrl(resp: SodaApiResponse): string | undefined {
  const body = responseBody(resp);
  const data = responseData(resp);
  return readString(data.qrurl) ?? readString(data.url) ?? readString(body.qrurl) ?? readString(body.url);
}

function ensureConfiguredUrl(url: string, name: string): string {
  const normalized = url.trim();
  if (!normalized) {
    throw new Error(`${name}_MISSING`);
  }
  return normalized;
}

function readSodaQrCodeBody(body: unknown): { qrcode: string; token: string } {
  const root = asObj(body);
  const data = asObj(root?.data) ?? root;
  const message = readString(root?.message) ?? readString(data?.message) ?? "";
  if (message !== "success") {
    throw new Error("SODA_QR_CODE_REQUEST_FAILED");
  }
  const qrcode = readString(data?.qrcode) ?? "";
  const token = readString(data?.token) ?? "";
  if (!qrcode || !token) {
    throw new Error("SODA_QR_CODE_DATA_MISSING");
  }
  return { qrcode, token };
}

function splitCombinedSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  if (values.length > 0) return values.flatMap(splitCombinedSetCookieHeader);

  const combined = readString(headers.get("set-cookie"));
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function cookieFromSetCookieHeaders(headers: Headers): string | undefined {
  const cookie = readSetCookieHeaders(headers)
    .map((header) => header.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
  return readString(cookie);
}

async function parseFetchJson(resp: Response): Promise<SodaApiResponse> {
  const text = await resp.text();
  if (!text.trim()) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: {} };
  }
}

export function createSodaQrLoginService(deps: SodaQrLoginDeps = {}): SodaQrLoginService {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const qrCreate = deps.qrCreate;
  const qrCodeUrl = deps.qrCodeUrl ?? SODA_QR_CODE_URL;
  const qrCheckUrl = deps.qrCheckUrl ?? SODA_QR_CHECK_URL;
  const qrCheckReferer = deps.qrCheckReferer ?? SODA_QR_CHECK_REFERER;
  const qrCheckUserAgent = deps.qrCheckUserAgent ?? SODA_QR_CHECK_USER_AGENT;

  async function loadQrImage(): Promise<ProviderLoginQrImage> {
    if (qrCreate) {
      const resp = await qrCreate({ timestamp: now() });
      const token = readQrToken(resp);
      const img = readQrImage(resp);
      if (!token) throw new Error("SODA_QR_TOKEN_MISSING");
      if (!img) throw new Error("SODA_QR_IMAGE_MISSING");
      return ProviderLoginQrImageSchema.parse({
        provider: SODA_PROVIDER,
        key: token,
        img,
        url: readQrUrl(resp)
      });
    }

    const url = ensureConfiguredUrl(qrCodeUrl, "SODA_QR_CODE_URL");
    const resp = await fetcher(url, { method: "GET" });
    if (!resp.ok) {
      throw new Error(`SODA_QR_CODE_HTTP_${resp.status}`);
    }
    const payload = readSodaQrCodeBody(await resp.json());
    return ProviderLoginQrImageSchema.parse({
      provider: SODA_PROVIDER,
      key: payload.token,
      img: payload.qrcode
    });
  }

  return {
    async createImage() {
      return loadQrImage();
    },

    async check(key: string) {
      const normalizedKey = key.trim();
      if (!normalizedKey) throw new Error("SODA_QR_KEY_REQUIRED");

      const url = ensureConfiguredUrl(qrCheckUrl, "SODA_QR_CHECK_URL");
      const body = new URLSearchParams({
        need_logo: "false",
        need_short_url: "false",
        is_frontier: "true",
        token: normalizedKey,
        is_new_login: "1",
        next: "https://api.qishui.com"
      }).toString();
      const resp = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Referer: qrCheckReferer,
          "user-agent": qrCheckUserAgent
        },
        body
      });
      if (!resp.ok) {
        throw new Error(`SODA_QR_CHECK_HTTP_${resp.status}`);
      }

      const parsed = await parseFetchJson(resp);
      const data = asObj(asObj(parsed.body)?.data) ?? {};
      const status = readString(data.status) ?? "";

      const loggedIn = status === "confirmed";
      const scanned = status === "scanned";
      const expired = status === "expired";

      const stored = loggedIn;

      const code = data.error_code ?? 0;
      const message = scanned
        ? readString(asObj(data.scan_user_info)?.avatar_url) ?? ""
        : readString(data.qrcode) ?? "";
      const nextKey = expired ? readString(data.token) : undefined;
      if (loggedIn) {
        const cookie = cookieFromSetCookieHeaders(resp.headers);
        if (cookie) setRuntimeProviderCookie("soda", cookie);
      }
      return ProviderLoginQrCheckSchema.parse({
        provider: SODA_PROVIDER,
        key: nextKey ?? normalizedKey,
        code,
        message,
        loggedIn,
        scanned,
        expired,
        stored
      });
    }
  };
}

export const sodaQrLogin = createSodaQrLoginService();
