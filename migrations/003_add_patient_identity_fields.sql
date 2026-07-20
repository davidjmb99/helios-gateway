-- ==========================================
-- Helios Gateway — Migración 003
-- Agregar campos de identidad al perfil de paciente
-- ==========================================
-- INSTRUCCIONES: Ejecutar manualmente en el SQL Editor de Supabase ANTES del deploy.
-- Cambios aditivos e idempotentes. No elimina ni renombra columnas existentes.

ALTER TABLE public.helios_patient_profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS profile_complete BOOLEAN NOT NULL DEFAULT FALSE;
