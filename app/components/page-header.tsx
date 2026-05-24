export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
      <div className="flex-1 min-w-0">
        {eyebrow &&
          (typeof eyebrow === "string" ? (
            <span className="sl-eyebrow mb-4 inline-block">{eyebrow}</span>
          ) : (
            <div className="mb-4 text-xs">{eyebrow}</div>
          ))}
        <h1 className="text-[28px] font-extrabold text-[#11242e] leading-tight tracking-tight">
          {title}
        </h1>
        {subtitle && <p className="text-sm text-[#5a6a72] mt-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </div>
  );
}
