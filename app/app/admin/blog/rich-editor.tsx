"use client";

// Rich text editor for the blog body. Tiptap + StarterKit, with the markdown
// extension so the editor round-trips Charlotte's existing markdown body
// transparently — the build script keeps reading markdown.
//
// SEO discipline baked in:
//   - H1 is the post title (rendered by the live template). The body editor
//     only offers H2 / H3 / H4 so the page outline can't accidentally have
//     two H1s.
//   - Toolbar = only the formats the live blog template actually styles:
//     H2/H3/H4, bold, italic, links, bullet + ordered lists, blockquote,
//     code, horizontal rule, inline image (via uploadBlogMediaAction).
//
// Inline image upload reuses the same Storage path + RLS as the cover
// image (blog-media bucket, migration 0170). The toolbar's image button
// opens a file picker → uploads → inserts the resulting public URL into
// the editor → onUpdate fires the markdown body back to the form.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Markdown } from "tiptap-markdown";
import { uploadBlogMediaAction } from "./actions";

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  postSlug: string | null;
}

export function RichEditor({ value, onChange, disabled, postSlug }: Props) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadPending, startUpload] = useTransition();
  // Guards the onUpdate → onChange → re-render → setContent loop.
  // Without this, setting content from props would clobber the user's
  // current cursor every keystroke.
  const lastEmittedRef = useRef<string>(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // H1 is the page title; body can use H2-H4 only. Heading toolbar
        // buttons honour this list.
        heading: { levels: [2, 3, 4] },
        // Strict horizontal-rule shape that round-trips through markdown.
        horizontalRule: { HTMLAttributes: { class: "post-hr" } },
      }),
      Markdown.configure({
        html: false,            // never preserve raw HTML in the body
        breaks: false,          // single line-breaks DON'T become <br>; matches build parser
        linkify: false,         // explicit link insertion only (avoids surprise auto-linking)
        transformPastedText: true,
      }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: "noopener", target: "_blank" },
      }),
      Image.configure({
        inline: false,
        HTMLAttributes: { class: "post-inline-image" },
      }),
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,   // SSR-safe (Next.js renders on client only)
    onUpdate: ({ editor }) => {
      // tiptap-markdown attaches a non-typed `markdown` property to
      // editor.storage at runtime; cast through unknown to keep type-checks
      // clean without polluting global @tiptap/core types.
      const storage = editor.storage as unknown as { markdown: { getMarkdown: () => string } };
      const md = storage.markdown.getMarkdown();
      lastEmittedRef.current = md;
      onChange(md);
    },
  });

  // Keep editor content in sync if the parent replaces the body wholesale
  // (e.g. AI Suggest outline button writes a new outline). Only run when
  // the incoming value differs from what we last emitted — otherwise we'd
  // reset the cursor on every keystroke.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
    lastEmittedRef.current = value;
  }, [value, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  const insertImage = useCallback(() => {
    if (!editor) return;
    fileInputRef.current?.click();
  }, [editor]);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !editor) return;
      setUploadError(null);
      // Prompt for alt text before insert. Skipping defaults to filename
      // (e.g. "IMG_4291.jpg") which tanks accessibility + image SEO. Empty
      // input is allowed (decorative image) but at least Charlotte saw the
      // prompt and made a choice.
      const altPrompt = window.prompt(
        "Alt text for this image (what's in it; leave blank if purely decorative):",
        "",
      );
      const alt = (altPrompt ?? "").trim();
      startUpload(async () => {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("post_slug", postSlug ?? "misc");
        const result = await uploadBlogMediaAction(fd);
        if (!result.ok) {
          setUploadError(result.error);
        } else {
          editor.chain().focus().setImage({ src: result.public_url, alt }).run();
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
      });
    },
    [editor, postSlug],
  );

  const insertLink = useCallback(() => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL (leave empty to unlink)", previous ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  if (!editor) {
    return (
      <div className="border border-input rounded-lg bg-white min-h-[500px] flex items-center justify-center text-sm text-[#5a6a72]">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="border border-input rounded-lg bg-white overflow-hidden focus-within:border-[#287271] focus-within:ring-2 focus-within:ring-[#287271]/30 transition-all">
      <Toolbar
        editor={editor}
        onInsertImage={insertImage}
        onInsertLink={insertLink}
        uploadPending={uploadPending}
        disabled={disabled}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
        onChange={onFileChange}
        className="hidden"
      />

      {uploadError && (
        <div className="border-b border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-3 py-2 text-[11px]">
          Image upload failed: {uploadError}
        </div>
      )}

      <EditorContent
        editor={editor}
        className="
          min-h-[560px] max-h-[760px] overflow-y-auto px-5 py-4 text-[15px] leading-relaxed text-[#11242e]
          [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[500px]
          [&_.ProseMirror_p]:my-3 [&_.ProseMirror_p]:leading-[1.7]
          [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-extrabold [&_.ProseMirror_h2]:mt-7 [&_.ProseMirror_h2]:mb-2
          [&_.ProseMirror_h3]:text-lg [&_.ProseMirror_h3]:font-bold [&_.ProseMirror_h3]:mt-5 [&_.ProseMirror_h3]:mb-2
          [&_.ProseMirror_h4]:text-base [&_.ProseMirror_h4]:font-bold [&_.ProseMirror_h4]:mt-4 [&_.ProseMirror_h4]:mb-1
          [&_.ProseMirror_strong]:font-bold [&_.ProseMirror_strong]:text-[#11242e]
          [&_.ProseMirror_em]:italic
          [&_.ProseMirror_a]:text-[#287271] [&_.ProseMirror_a]:underline-offset-2 [&_.ProseMirror_a]:underline
          [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ul]:my-3
          [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ol]:my-3
          [&_.ProseMirror_li]:my-1
          [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-[#287271] [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:my-4
          [&_.ProseMirror_code]:bg-[#f5f2eb] [&_.ProseMirror_code]:px-1.5 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:text-[0.9em] [&_.ProseMirror_code]:font-mono
          [&_.ProseMirror_pre]:bg-[#11242e] [&_.ProseMirror_pre]:text-white [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:my-4 [&_.ProseMirror_pre_code]:bg-transparent [&_.ProseMirror_pre_code]:text-white [&_.ProseMirror_pre_code]:p-0
          [&_.ProseMirror_hr]:my-6 [&_.ProseMirror_hr]:border-[#e5dfd8]
          [&_.ProseMirror_img]:rounded-md [&_.ProseMirror_img]:my-4 [&_.ProseMirror_img]:max-w-full
          [&_.ProseMirror_img.ProseMirror-selectednode]:outline [&_.ProseMirror_img.ProseMirror-selectednode]:outline-2 [&_.ProseMirror_img.ProseMirror-selectednode]:outline-[#287271]
          [&_.ProseMirror.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_.ProseMirror.is-editor-empty:first-child]:before:text-[#5a6a72] [&_.ProseMirror.is-editor-empty:first-child]:before:float-left [&_.ProseMirror.is-editor-empty:first-child]:before:h-0 [&_.ProseMirror.is-editor-empty:first-child]:before:pointer-events-none
        "
      />
    </div>
  );
}

function Toolbar({
  editor,
  onInsertImage,
  onInsertLink,
  uploadPending,
  disabled,
}: {
  editor: Editor;
  onInsertImage: () => void;
  onInsertLink: () => void;
  uploadPending: boolean;
  disabled?: boolean;
}) {
  const btn = "px-2 py-1 rounded text-[12px] font-semibold hover:bg-[#287271] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit cursor-pointer transition-colors";
  const active = "bg-[#287271] text-white";
  const idle = "text-[#11242e]";

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-[#e5dfd8] bg-[#f5f2eb]">
      <Btn className={`${btn} ${editor.isActive("heading", { level: 2 }) ? active : idle}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        disabled={disabled}
        title="Section heading (H2) — top-level sections of the post"
      >H2</Btn>
      <Btn className={`${btn} ${editor.isActive("heading", { level: 3 }) ? active : idle}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        disabled={disabled}
        title="Sub-heading (H3) — sections inside an H2"
      >H3</Btn>
      <Btn className={`${btn} ${editor.isActive("heading", { level: 4 }) ? active : idle}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
        disabled={disabled}
        title="Sub-sub-heading (H4) — rarely needed"
      >H4</Btn>

      <Divider />

      <Btn className={`${btn} ${editor.isActive("bold") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={disabled}
        title="Bold (Cmd+B)"
      ><strong>B</strong></Btn>
      <Btn className={`${btn} ${editor.isActive("italic") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={disabled}
        title="Italic (Cmd+I)"
      ><em>I</em></Btn>
      <Btn className={`${btn} ${editor.isActive("link") ? active : idle}`}
        onClick={onInsertLink}
        disabled={disabled}
        title="Link"
      >🔗 Link</Btn>

      <Divider />

      <Btn className={`${btn} ${editor.isActive("bulletList") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        disabled={disabled}
        title="Bulleted list"
      >• List</Btn>
      <Btn className={`${btn} ${editor.isActive("orderedList") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        disabled={disabled}
        title="Numbered list"
      >1. List</Btn>
      <Btn className={`${btn} ${editor.isActive("blockquote") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        disabled={disabled}
        title="Quote"
      >❝ Quote</Btn>

      <Divider />

      <Btn className={`${btn} ${editor.isActive("code") ? active : idle}`}
        onClick={() => editor.chain().focus().toggleCode().run()}
        disabled={disabled}
        title="Inline code"
      >{`<code>`}</Btn>
      <Btn className={`${btn} ${idle}`}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        disabled={disabled}
        title="Horizontal rule"
      >— HR</Btn>

      <Divider />

      <Btn className={`${btn} ${idle}`}
        onClick={onInsertImage}
        disabled={disabled || uploadPending}
        title="Insert image (uploads to Supabase Storage)"
      >{uploadPending ? "Uploading…" : "🖼 Image"}</Btn>
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-[#d4ccc0] mx-0.5" />;
}

function Btn({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  );
}
