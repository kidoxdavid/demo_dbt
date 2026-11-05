import { ICONS, type IconName } from './iconPaths';
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg className="ico" style={size === 20 ? undefined : { width: size, height: size }} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
export type { IconName };
