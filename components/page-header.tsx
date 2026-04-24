export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      {eyebrow && (
        <span className="sl-eyebrow mb-4 inline-block">{eyebrow}</span>
      )}
      <h1 className="text-[28px] font-extrabold text-[#11242e] leading-tight tracking-tight">
        {title}
      </h1>
      {subtitle && <p className="text-sm text-[#5a6a72] mt-2">{subtitle}</p>}
    </div>
  );
}
