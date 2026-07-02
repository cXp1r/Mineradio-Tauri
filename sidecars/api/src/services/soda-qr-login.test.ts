import { expect, test } from "bun:test";
import { clearRuntimeProviderCookie, getProviderCookie } from "./auth-session";
import { createSodaQrLoginService } from "./soda-qr-login";

test("soda QR login service creates key image and stores cookie on successful check", async () => {
  clearRuntimeProviderCookie("soda");
  const service = createSodaQrLoginService({
    qrKey: async () => ({
      body: {
        data: {
          key: "soda-qr-key-1"
        }
      }
    }),
    qrCreate: async () => ({
      body: {
        data: {
          qrimg: "data:image/png;base64,soda"
        }
      }
    }),
    qrCheck: async () => ({
      body: {
        data: {
          code: 803,
          message: "login success",
          cookie: "soda_session=abc123"
        }
      }
    })
  });

  const key = await service.createKey();
  expect(key).toEqual({ provider: "soda", key: "soda-qr-key-1" });

  const image = await service.createImage(key.key);
  expect(image).toEqual({
    provider: "soda",
    key: "soda-qr-key-1",
    img: "data:image/png;base64,soda"
  });

  const checked = await service.check(key.key);
  expect(checked.provider).toBe("soda");
  expect(checked.loggedIn).toBe(true);
  expect(checked.stored).toBe(true);
  expect(getProviderCookie("soda")).toBe("soda_session=abc123");

  clearRuntimeProviderCookie("soda");
});
