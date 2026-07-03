import {
  LayoutDashboard,
  CalendarDays,
  ClipboardList,
  ClipboardCheck,
  Users,
  BedDouble,
  Ban,
  ArrowRightLeft,
  Sparkles,
  Wrench,
  IdCard,
  Clock,
  FileText,
  Wallet,
  Truck,
  BarChart3,
  Zap,
  Share2,
  Settings,
  Shield,
  Plus,
  Search,
  Bell,
  Moon,
  Languages,
  LogOut,
  LogIn,
  ChevronDown,
  Eye,
  EyeOff,
  Lock,
  User,
  Building2,
  type LucideIcon,
} from "lucide-react";

// Single icon mapper (overview §3 / DECISIONS D3). Reference the glyph everywhere by
// its semantic name so swapping the icon set is a one-file change.
const ICONS = {
  dashboard: LayoutDashboard,
  calendar: CalendarDays,
  reservations: ClipboardList,
  guests: Users,
  rooms: BedDouble,
  "room-blocks": Ban,
  "bulk-update": ArrowRightLeft,
  cleaning: Sparkles,
  maintenance: Wrench,
  employees: IdCard,
  attendance: Clock,
  "my-requests": FileText,
  "approve-requests": ClipboardCheck,
  documents: FileText,
  finance: Wallet,
  suppliers: Truck,
  reports: BarChart3,
  automations: Zap,
  channels: Share2,
  settings: Settings,
  permissions: Shield,
  plus: Plus,
  search: Search,
  bell: Bell,
  moon: Moon,
  languages: Languages,
  logout: LogOut,
  login: LogIn,
  chevron: ChevronDown,
  eye: Eye,
  "eye-off": EyeOff,
  lock: Lock,
  user: User,
  building: Building2,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className,
  size = 20,
  strokeWidth = 1.8,
}: {
  name: IconName;
  className?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={className}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden
    />
  );
}
