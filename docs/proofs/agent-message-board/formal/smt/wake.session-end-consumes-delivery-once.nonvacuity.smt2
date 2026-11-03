; benchmark generated from python API
(set-info :status unknown)
(declare-fun s_boundary () Int)
(declare-fun s_delivered () Int)
(declare-fun s_global () Int)
(assert
 (>= s_boundary 0))
(assert
 (>= s_global s_delivered))
(assert
 (>= s_delivered 0))
(check-sat)
