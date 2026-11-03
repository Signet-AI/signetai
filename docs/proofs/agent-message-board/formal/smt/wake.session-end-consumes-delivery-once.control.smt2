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
(assert
 (let (($x855 (> s_delivered s_boundary)))
(let ((?x22 (ite $x855 s_boundary s_boundary)))
(let (($x16 (> s_delivered ?x22)))
(let (($x224 (not $x16)))
(not $x224))))))
(check-sat)
