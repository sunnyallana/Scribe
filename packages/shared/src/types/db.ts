// Database type for Scribe's Supabase schema.
//
// To regenerate from a live local Supabase: `pnpm gen:db`
// (which runs `supabase gen types typescript --local`).
// This file is the canonical contract that server and client both depend on.
// Lint rules disabled to match supabase gen output verbatim (type aliases,
// index signatures for empty schemas).
/* eslint-disable @typescript-eslint/consistent-type-definitions */
/* eslint-disable @typescript-eslint/consistent-indexed-object-style */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          avatar_url: string | null;
          ai_config: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string | null;
          avatar_url?: string | null;
          ai_config?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          display_name?: string | null;
          avatar_url?: string | null;
          ai_config?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          owner_id: string;
          template: string;
          compiler: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file: string;
          is_public: boolean;
          archived_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          description?: string | null;
          owner_id: string;
          template?: string;
          compiler?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file?: string;
          is_public?: boolean;
          archived_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          description?: string | null;
          owner_id?: string;
          template?: string;
          compiler?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file?: string;
          is_public?: boolean;
          archived_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'projects_owner_id_fkey';
            columns: ['owner_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          user_id: string | null;
          invited_email: string | null;
          role: 'owner' | 'editor' | 'commenter' | 'viewer';
          invite_token: string | null;
          invited_at: string;
          invite_expires_at: string;
          invite_accepted_at: string | null;
          invited_by: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id?: string | null;
          invited_email?: string | null;
          role: 'owner' | 'editor' | 'commenter' | 'viewer';
          invite_token?: string | null;
          invited_at?: string;
          invite_expires_at?: string;
          invite_accepted_at?: string | null;
          invited_by?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          user_id?: string | null;
          invited_email?: string | null;
          role?: 'owner' | 'editor' | 'commenter' | 'viewer';
          invite_token?: string | null;
          invited_at?: string;
          invite_expires_at?: string;
          invite_accepted_at?: string | null;
          invited_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'project_members_project_id_fkey';
            columns: ['project_id'];
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'project_members_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'project_members_invited_by_fkey';
            columns: ['invited_by'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      project_files: {
        Row: {
          id: string;
          project_id: string;
          path: string;
          type: 'tex' | 'bib' | 'image' | 'other';
          storage_key: string;
          size_bytes: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          path: string;
          type: 'tex' | 'bib' | 'image' | 'other';
          storage_key: string;
          size_bytes: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          path?: string;
          type?: 'tex' | 'bib' | 'image' | 'other';
          storage_key?: string;
          size_bytes?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'project_files_project_id_fkey';
            columns: ['project_id'];
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'project_files_created_by_fkey';
            columns: ['created_by'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      project_versions: {
        Row: {
          id: string;
          project_id: string;
          created_by: string | null;
          label: string | null;
          storage_key: string;
          file_count: number;
          total_bytes: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          created_by?: string | null;
          label?: string | null;
          storage_key: string;
          file_count?: number;
          total_bytes?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          created_by?: string | null;
          label?: string | null;
          storage_key?: string;
          file_count?: number;
          total_bytes?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'project_versions_project_id_fkey';
            columns: ['project_id'];
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
        ];
      };
      comments: {
        Row: {
          id: string;
          project_id: string;
          file_id: string | null;
          parent_id: string | null;
          author_id: string;
          anchor_line: number | null;
          anchor_column: number | null;
          body: string;
          resolved_at: string | null;
          resolved_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          file_id?: string | null;
          parent_id?: string | null;
          author_id: string;
          anchor_line?: number | null;
          anchor_column?: number | null;
          body: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          file_id?: string | null;
          parent_id?: string | null;
          author_id?: string;
          anchor_line?: number | null;
          anchor_column?: number | null;
          body?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_project_id_fkey';
            columns: ['project_id'];
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'comments_author_id_fkey';
            columns: ['author_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      yjs_updates: {
        Row: {
          id: number;
          doc_id: string;
          update_data: string; // bytea returned as base64 / hex by PostgREST
          clock: number;
          created_at: string;
        };
        Insert: {
          id?: number;
          doc_id: string;
          update_data: string;
          clock?: number;
          created_at?: string;
        };
        Update: {
          id?: number;
          doc_id?: string;
          update_data?: string;
          clock?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      compile_jobs: {
        Row: {
          id: string;
          project_id: string;
          triggered_by: string | null;
          status: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
          engine: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file: string;
          exit_code: number | null;
          pdf_key: string | null;
          log_key: string | null;
          synctex_key: string | null;
          error_message: string | null;
          entries: Json | null;
          duration_ms: number | null;
          enqueued_at: string;
          started_at: string | null;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          triggered_by?: string | null;
          status?: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
          engine: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file: string;
          exit_code?: number | null;
          pdf_key?: string | null;
          log_key?: string | null;
          synctex_key?: string | null;
          error_message?: string | null;
          entries?: Json | null;
          duration_ms?: number | null;
          enqueued_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          project_id?: string;
          triggered_by?: string | null;
          status?: 'queued' | 'running' | 'success' | 'error' | 'cancelled';
          engine?: 'tectonic' | 'pdflatex' | 'xelatex' | 'lualatex';
          main_file?: string;
          exit_code?: number | null;
          pdf_key?: string | null;
          log_key?: string | null;
          synctex_key?: string | null;
          error_message?: string | null;
          entries?: Json | null;
          duration_ms?: number | null;
          enqueued_at?: string;
          started_at?: string | null;
          completed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'compile_jobs_project_id_fkey';
            columns: ['project_id'];
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'compile_jobs_triggered_by_fkey';
            columns: ['triggered_by'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_project_member: {
        Args: { p_project_id: string; p_user_id: string };
        Returns: boolean;
      };
      project_role: {
        Args: { p_project_id: string; p_user_id: string };
        Returns: string;
      };
      my_project_role: {
        Args: { p_project_id: string };
        Returns: string;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type TableRow<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TableInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TableUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
