import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadToastContent } from "../client/components/app-toasts";

describe("UploadToastContent", () => {
  test("renders determinate upload progress", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "1",
          name: "clip.mov",
          kind: "media",
          status: "uploading",
          progress: 0.42,
        }}
      />,
    );

    expect(html).toContain('data-testid="upload-toast"');
    expect(html).toContain("Uploading clip.mov… 42%");
    expect(html).toContain("width:42%");
  });

  test("renders completed media and ipa messages", () => {
    const media = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "1", name: "photo.png", kind: "media", status: "success", progress: null }}
      />,
    );
    const ipa = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "2", name: "App.ipa", kind: "ipa", status: "success", progress: null }}
      />,
    );

    expect(media).toContain("Added photo.png to Photos");
    expect(ipa).toContain("Installed App.ipa");
  });
});
