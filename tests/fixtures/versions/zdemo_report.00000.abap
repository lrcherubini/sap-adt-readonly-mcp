*&---------------------------------------------------------------------*
*& Report ZDEMO_REPORT
*&---------------------------------------------------------------------*
*&
*&---------------------------------------------------------------------*
REPORT zdemo_report.

TABLES e070.

PARAMETERS p_test AS CHECKBOX TYPE flag.
PARAMETERS p_str TYPE string DEFAULT 'str2'.
SELECT-OPTIONS s_trkorr FOR e070-trkorr.