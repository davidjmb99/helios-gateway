-- Tabla de Clientes/Clínicas (Tenants)
CREATE TABLE IF NOT EXISTS public.helios_tenants (
    tenant_id text PRIMARY KEY,
    name text NOT NULL,
    username text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Insertar clínica demo
INSERT INTO public.helios_tenants (tenant_id, name, username, password_hash)
VALUES ('democoi1', 'Clínica Dental Demo COI', 'democoi1', 'democoi1')
ON CONFLICT (tenant_id) DO UPDATE 
SET password_hash = 'democoi1', name = 'Clínica Dental Demo COI';
