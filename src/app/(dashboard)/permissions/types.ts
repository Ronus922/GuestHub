export type Role = {
  id: string;
  key: string;
  name: string;
  is_system: boolean;
};

export type Permission = {
  id: string;
  key: string;
  description: string | null;
  category: string | null;
};

export type Grant = { role_id: string; permission_id: string };

export type ActionResult = { success: boolean; error?: string };
