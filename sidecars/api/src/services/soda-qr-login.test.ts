import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, getProviderCookie } from "./auth-session";
import { createSodaQrLoginService } from "./soda-qr-login";

test("soda QR login service creates key image and stores cookie on successful check", async () => {
  clearRuntimeProviderCookie("soda");
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const service = createSodaQrLoginService({
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      if (init?.method === "GET") {
        return new Response(JSON.stringify({
          message: "success",
          data: {
            token: "soda-qr-key-1",
            qrcode: "data:image/png;base64,soda"
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        message: "success",
        data: {
          error_code: 0,
          status: "confirmed"
        }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "soda_session=abc123"
        }
      });
    },
    qrCodeUrl: "https://soda.example/qr-code",
    qrCheckUrl: "https://soda.example/qr-check",
    qrCheckReferer: "https://soda.example/login",
    qrCheckUserAgent: "Soda Test Agent"
  });

  const image = await service.createImage();
  expect(image).toEqual({
    provider: "soda",
    key: "soda-qr-key-1",
    img: "data:image/png;base64,soda"
  });
  expect(await service.createImage(image.key)).toEqual(image);

  const checked = await service.check(image.key);
  expect(checked.provider).toBe("soda");
  expect(checked.loggedIn).toBe(true);
  expect(checked.stored).toBe(true);
  expect(getProviderCookie("soda")).toBe("soda_session=abc123");
  expect(calls.length).toBe(2);
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[1]?.init?.method).toBe("POST");
  expect(calls[1]?.init?.headers).toMatchObject({
    "content-type": "application/x-www-form-urlencoded",
    Referer: "https://soda.example/login",
    "user-agent": "Soda Test Agent"
  });
  expect(String(calls[1]?.init?.body)).toBe(
    "need_logo=false&need_short_url=false&is_frontier=true&token=soda-qr-key-1&is_new_login=1&next=https%3A%2F%2Fapi.qishui.com"
  );

  clearRuntimeProviderCookie("soda");
});

test("soda QR login service stores only cookie pairs from multiple set-cookie headers", async () => {
  clearRuntimeProviderCookie("soda");
  const service = createSodaQrLoginService({
    fetch: async () => new Response(JSON.stringify({
      message: "success",
      data: {
        error_code: 0,
        status: "confirmed"
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "soda_session=abc123; Path=/; HttpOnly, passport=token456; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; Secure"
      }
    }),
    qrCheckUrl: "https://soda.example/qr-check"
  });

  const checked = await service.check("soda-qr-key-1");

  expect(checked.loggedIn).toBe(true);
  expect(checked.stored).toBe(true);
  expect(getProviderCookie("soda")).toBe("soda_session=abc123; passport=token456");

  clearRuntimeProviderCookie("soda");
});

test("soda QR login service keeps polling when confirmed response has no set-cookie header", async () => {
  clearRuntimeProviderCookie("soda");
  const service = createSodaQrLoginService({
    fetch: async () => new Response(JSON.stringify({
      message: "success",
      data: {
        error_code: 0,
        status: "confirmed"
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    qrCheckUrl: "https://soda.example/qr-check"
  });

  const checked = await service.check("soda-qr-key-1");

  expect(checked.loggedIn).toBe(false);
  expect(checked.stored).toBe(false);
  expect(getProviderCookie("soda")).toBe(undefined);

  clearRuntimeProviderCookie("soda");
});

test("soda QR login service loads qrcode from the fetch endpoint when no qrCreate is injected", async () => {
  clearRuntimeProviderCookie("soda");
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const service = createSodaQrLoginService({
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        message: "success",
        data: {
          qrcode: "data:image/png;base64,from-fetch",
          token: "fetch-token-1"
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    qrCodeUrl: "https://soda.example/qr-code"
  });

  const image = await service.createImage();
  expect(image).toEqual({
    provider: "soda",
    key: "fetch-token-1",
    img: "data:image/png;base64,from-fetch"
  });
  expect(calls.length).toBe(1);
  expect(calls[0]?.init?.method).toBe("GET");
});

test("soda QR login service creates a fresh qrcode for each create call", async () => {
  clearRuntimeProviderCookie("soda");
  let count = 0;
  const service = createSodaQrLoginService({
    fetch: async () => {
      count += 1;
      return new Response(JSON.stringify({
        message: "success",
        data: {
          qrcode: `data:image/png;base64,from-fetch-${count}`,
          token: `fetch-token-${count}`
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    qrCodeUrl: "https://soda.example/qr-code"
  });

  const first = await service.createImage();
  const second = await service.createImage();
  expect(first.key).toBe("fetch-token-1");
  expect(second.key).toBe("fetch-token-2");
  expect(first.img).toBe("data:image/png;base64,from-fetch-1");
  expect(second.img).toBe("data:image/png;base64,from-fetch-2");
  expect(count).toBe(2);
});

test("soda QR login service marks scanned status before cookie login success", async () => {
  clearRuntimeProviderCookie("soda");
  const service = createSodaQrLoginService({
    fetch: async () => new Response(JSON.stringify({
      data: {
        captcha: "",
        desc_url: "",
        description: "",
        error_code: 0,
        extra: "",
        scan_app_id: 8478,
        scan_device_info: {
          device_id: 0,
          app_id: 0,
          ip: "",
          verify_time: 0,
          verify_way: "",
          scan_device_display_name: "mobile"
        },
        scan_user_info: {
          user_id: 0,
          screen_name: "",
          avatar_url: "https://example.test/avatar.jpeg"
        },
        status: "scanned"
      },
      message: "success"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    qrCheckUrl: "https://soda.example/qr-check"
  });

  const checked = await service.check("soda-qr-key-1");
  expect(checked).toMatchObject({
    provider: "soda",
    key: "soda-qr-key-1",
    loggedIn: false,
    scanned: true,
    expired: false,
    stored: false
  });
  expect(getProviderCookie("soda")).toBe(undefined);
});
