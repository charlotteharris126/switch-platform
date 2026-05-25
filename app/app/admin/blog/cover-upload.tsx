"use client";

// Drop-in replacement for the cover_image_url text field. Lets Charlotte
// upload an image directly OR paste a URL. Either path produces a URL that
// gets dropped into the field via onChange.

import { useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { uploadBlogMediaAction, type UploadResult } from "./actions";

interface Props {
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
  postSlug: string | null;
  placeholder?: string;
}

export function CoverUpload({ value, onChange, disabled, postSlug, placeholder }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<Extract<UploadResult, { ok: true }> | null>(null);

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("post_slug", postSlug ?? "misc");
      const result = await uploadBlogMediaAction(formData);
      if (!result.ok) {
        setError(result.error);
      } else {
        setLastUpload(result);
        onChange(result.public_url);
      }
      // Reset file input so re-selecting the same file fires onChange again.
      if (fileInputRef.current) fileInputRef.current.value = "";
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "/brand/blog/your-slug.jpg or paste a URL — or upload below"}
          disabled={disabled || pending}
          className="flex-1"
        />
        <button
          type="button"
          onClick={pickFile}
          disabled={disabled || pending}
          className="px-3 py-1.5 bg-[#287271] text-white rounded-md text-xs font-semibold hover:bg-[#1e5b5a] disabled:opacity-60 cursor-pointer whitespace-nowrap"
        >
          {pending ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
          onChange={onFileChange}
          className="hidden"
        />
      </div>

      {error && (
        <div className="rounded-md border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-3 py-2 text-[11px]">
          {error}
        </div>
      )}

      {lastUpload && (
        <p className="text-[10px] text-[#5a6a72]">
          ✓ Uploaded · {(lastUpload.size_bytes / 1024).toFixed(0)} KB · <code className="font-mono">{lastUpload.storage_path}</code>
        </p>
      )}

      {value && /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(value) && (
        // Live preview of the current URL value. Click to open full-size in a new tab.
        // eslint-disable-next-line @next/next/no-img-element
        <a href={value} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={value}
            alt="Cover preview"
            className="max-h-40 rounded-md border border-[#e5dfd8] object-cover"
            onError={(e) => {
              // Replace the broken preview with a visible warning rather
              // than silently hiding it — otherwise Charlotte may not notice
              // the URL doesn't resolve until preview/publish.
              const img = e.currentTarget as HTMLImageElement;
              img.style.display = "none";
              const warning = img.parentElement?.parentElement?.querySelector(".cover-upload-broken");
              if (warning) (warning as HTMLElement).style.display = "block";
            }}
          />
        </a>
      )}

      <p className="cover-upload-broken text-[11px] text-[#b3412e] mt-1" style={{ display: "none" }}>
        Cover image URL didn't load. Check the URL is public + the file exists, or upload a new image.
      </p>
    </div>
  );
}
